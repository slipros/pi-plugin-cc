// Smoke: все хуки грузятся вместе через index.ts (проверка синтаксиса и импортов).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const src = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-"));
for (const f of fs.readdirSync(src).filter((f) => f.endsWith(".ts"))) {
  const text = fs
    .readFileSync(path.join(src, f), "utf8")
    .replace(/from "\.\/([a-z-]+)"/g, 'from "./$1.ts"');
  fs.writeFileSync(path.join(tmp, f), text);
}
const mod = await import(path.join(tmp, "index.ts"));
const registered = [];
const fakePi = { on: (evt) => registered.push(evt) };
mod.default(fakePi);
console.log("index.ts загрузился, хуков зарегистрировано:", registered.length);
fs.rmSync(tmp, { recursive: true, force: true });
