import { errorBody, RequestValidationError } from "@bugbaar/api";
import type { RateLimiter } from "@bugbaar/workflows";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Config } from "../config/index.js";
import type { Logger } from "../config/logger.js";
import type { Metrics } from "../observability/metrics.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

/** Tags each request with a correlation id, echoed back in `x-request-id`. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId =
      typeof req.headers["x-request-id"] === "string" ? req.headers["x-request-id"] : crypto.randomUUID();
    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader("x-request-id", requestId);
    next();
  };
}

export function accessLog(): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on("finish", () => {
      req.log.info("request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - start),
      });
    });
    next();
  };
}

/**
 * Records request counts and durations.
 *
 * The route *template* is used as the label, never the concrete path: a label
 * built from `/v1/agents/abc/run` would mint a new time series per agent and
 * eventually take out the Prometheus server. Unmatched paths collapse into a
 * single bucket for the same reason — a 404 scanner must not be able to create
 * unbounded cardinality.
 */
export function httpMetrics(metrics: Metrics): RequestHandler {
  return (req, res, next) => {
    const stop = metrics.httpDuration.startTimer();

    res.on("finish", () => {
      const route = routeLabel(req);
      stop({ method: req.method, route });
      metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    });

    next();
  };
}

/** The matched route pattern, or a single bucket for anything unmatched. */
function routeLabel(req: Request): string {
  const route: unknown = (req as { route?: unknown }).route;
  const path = typeof route === "object" && route !== null ? (route as { path?: unknown }).path : undefined;

  if (typeof path !== "string") return "unmatched";

  const base = req.baseUrl || "";
  return `${base}${path === "/" ? "" : path}` || "/";
}

export function cors(origin: string): RequestHandler {
  return (req, res, next) => {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type, x-api-key, x-request-id");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.removeHeader("x-powered-by");
    next();
  };
}

/**
 * API-key authentication.
 *
 * Keys are compared in constant time so response latency does not leak how
 * much of a guessed key was correct.
 */
export function apiKeyAuth(config: Config): RequestHandler {
  const keys = config.apiKeys;

  return (req, res, next) => {
    if (keys.length === 0) {
      // Development convenience only; loadConfig() rejects this in production.
      next();
      return;
    }

    const provided = req.headers["x-api-key"];
    const candidate = typeof provided === "string" ? provided : "";
    const authorised = keys.some((key) => timingSafeEqual(key, candidate));

    if (!authorised) {
      res.status(401).json(errorBody("unauthorized", "A valid x-api-key header is required", req.requestId));
      return;
    }
    next();
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

/**
 * Rate limiting keyed by API key, falling back to client IP.
 *
 * The counting itself lives behind `RateLimiter` so the same middleware works
 * against an in-process map or a shared Redis counter. Which one is in play
 * shows up in the `x-ratelimit-scope` header — `shared` or `local` — because
 * "the limit is 120" means something different per replica than it does
 * across a cluster.
 */
export function rateLimit(config: Config, limiter: RateLimiter, metrics?: Metrics): RequestHandler {
  return (req, res, next) => {
    const key = (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : req.ip) ?? "anonymous";

    limiter
      .consume(key)
      .then((decision) => {
        res.setHeader("x-ratelimit-limit", config.rateLimit.max);
        res.setHeader("x-ratelimit-remaining", decision.remaining);
        res.setHeader("x-ratelimit-scope", limiter.shared ? "shared" : "local");

        if (!decision.allowed) {
          metrics?.rateLimited.inc({ scope: limiter.shared ? "shared" : "local" });
          res.setHeader("retry-after", decision.retryAfterSeconds);
          res
            .status(429)
            .json(
              errorBody(
                "rate_limited",
                `Rate limit exceeded. Retry in ${decision.retryAfterSeconds}s`,
                req.requestId,
              ),
            );
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        // Redis being unreachable must not take the API down with it. Fail
        // open and record it — an unlimited request beats a dead endpoint.
        req.log.error("rate limiter unavailable, allowing request", {
          error: error instanceof Error ? error.message : String(error),
        });
        next();
      });
  };
}

export function notFound(): RequestHandler {
  return (req, res) => {
    res.status(404).json(errorBody("not_found", `No route for ${req.method} ${req.path}`, req.requestId));
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Terminal error handler. Internal failures are logged in full but never echoed to the client. */
export function errorHandler(config: Config) {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof RequestValidationError) {
      res.status(error.status).json(errorBody(error.code, error.message, req.requestId, error.details));
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json(errorBody(error.code, error.message, req.requestId, error.details));
      return;
    }

    // express.json() rejects malformed or oversized bodies with an error that
    // already carries the right 4xx status. Without this they fall through to
    // the 500 branch, so a client's bad JSON is reported as a server fault and
    // the reason is hidden in production.
    const clientError = asClientError(error);
    if (clientError) {
      res.status(clientError.status).json(errorBody(clientError.code, clientError.message, req.requestId));
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    req.log.error("unhandled error", { message, stack: error instanceof Error ? error.stack : undefined });

    res
      .status(500)
      .json(
        errorBody(
          "internal_error",
          config.env === "production" ? "An internal error occurred" : message,
          req.requestId,
        ),
      );
  };
}

/**
 * Reads a path parameter as a string.
 *
 * Express 5 types params as `string | string[]` because a route may repeat a
 * name; our routes never do, so collapse it and fail loudly if it is absent.
 */
export function pathParam(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string" || first === "") {
    throw new HttpError(400, "invalid_path", `Missing path parameter "${name}"`);
  }
  return first;
}

/**
 * Recognises the 4xx errors body-parser raises, which arrive as plain Errors
 * with a numeric `status` and a `type` rather than as one of our own classes.
 */
function asClientError(error: unknown): { status: number; code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as { status?: number; statusCode?: number; type?: string; message?: string };
  const status = candidate.status ?? candidate.statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;

  const code =
    candidate.type === "entity.parse.failed"
      ? "invalid_json"
      : candidate.type === "entity.too.large"
        ? "payload_too_large"
        : "invalid_request";

  const message =
    code === "invalid_json"
      ? "Request body is not valid JSON"
      : code === "payload_too_large"
        ? "Request body exceeds the size limit"
        : (candidate.message ?? "Invalid request");

  return { status, code, message };
}

/** Forwards rejections from async handlers to the error middleware. */
export function asyncHandler(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
