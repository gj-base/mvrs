import fs from "fs";

const p = new URL("../.deploy-submit-reservation.json", import.meta.url);
const o = JSON.parse(fs.readFileSync(p, "utf8"));
console.log(
  JSON.stringify({
    name: o.name,
    entrypoint_path: o.entrypoint_path,
    verify_jwt: o.verify_jwt,
    files_count: o.files.length,
    content_len: o.files[0].content.length,
    has_sbAdmin_insert: o.files[0].content.includes(
      'sbAdmin.from("reservations").insert',
    ),
    has_placeholder: o.files[0].content.includes("PLACEHOLDER"),
  }),
);
