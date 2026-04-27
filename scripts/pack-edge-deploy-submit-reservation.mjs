import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "supabase", "functions");
const idx = fs.readFileSync(path.join(root, "submit-reservation", "index.ts"), "utf8");
const out = {
  name: "submit-reservation",
  entrypoint_path: "index.ts",
  verify_jwt: false,
  files: [{ name: "index.ts", content: idx }],
};
const outPath = path.join(__dirname, "edge_deploy_submit_reservation.json");
fs.writeFileSync(outPath, JSON.stringify(out));
console.log("wrote", outPath, "bytes", fs.statSync(outPath).size);
