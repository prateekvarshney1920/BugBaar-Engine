import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatorTool } from "./builtin.ts";
import { ToolRegistry } from "./registry.ts";
import { validateInput, ToolValidationError } from "./validate.ts";

const context = { agentId: "test-agent", runId: "test-run" };

test("executes a registered tool", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute(
    { id: "1", name: "calculator", arguments: { a: 6, b: 7, operation: "multiply" } },
    context,
  );

  assert.equal(result.ok, true);
  assert.equal(result.output, 42);
});

test("reports unknown tools instead of throwing", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute({ id: "1", name: "nope", arguments: {} }, context);

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unknown tool/);
});

test("captures tool errors as failed results", async () => {
  const registry = new ToolRegistry([calculatorTool]);
  const result = await registry.execute(
    { id: "1", name: "calculator", arguments: { a: 1, b: 0, operation: "divide" } },
    context,
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "Division by zero");
});

test("rejects duplicate registration", () => {
  const registry = new ToolRegistry([calculatorTool]);
  assert.throws(() => registry.register(calculatorTool), /already registered/);
});

test("validation reports every missing field at once", () => {
  try {
    validateInput(calculatorTool.parameters, { a: 1 });
    assert.fail("expected validation to throw");
  } catch (error) {
    assert.ok(error instanceof ToolValidationError);
    assert.equal(error.issues.length, 2);
  }
});

test("validation rejects values outside an enum", () => {
  assert.throws(
    () => validateInput(calculatorTool.parameters, { a: 1, b: 2, operation: "modulo" }),
    /expected one of/,
  );
});
