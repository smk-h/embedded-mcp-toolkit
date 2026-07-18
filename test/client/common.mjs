export function pass(name) {
  console.log(`  ✔ ${name}`);
}

export function fail(name, detail) {
  console.log(`  ✘ ${name}`);
  if (detail) console.log(`    → ${detail}`);
}

export function assert(condition, name, detail) {
  if (condition) {
    pass(name);
  } else {
    fail(name, detail);
  }
  return condition;
}

export function printResult(result) {
  const text = result.content.map((c) => c.text).join("\n");
  console.log(`  ┌─ 返回结果 ─────────────────────────`);
  for (const line of text.split("\n")) {
    console.log(`  │ ${line}`);
  }
  console.log(`  └────────────────────────────────────`);
}
