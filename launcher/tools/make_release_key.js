// Create the release signing key (once).
//
// Releases are signed with an Ed25519 key: the private half stays on the PC
// that builds releases (never in the repo), the public half is built into the
// launcher (lib/releasekey.js), which refuses any manifest it doesn't verify.
// Losing the private key means shipping a new launcher with a new public key,
// so back it up somewhere safe.
//
// usage: node tools/make_release_key.js [private key path]
//   default: %USERPROFILE%\.culling-release\release_ed25519.pem

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_KEY = path.join(os.homedir(), ".culling-release", "release_ed25519.pem");

function main(keyPath = DEFAULT_KEY) {
  if (fs.existsSync(keyPath)) {
    console.error("a release key already exists at " + keyPath + " (not replaced)");
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pub = publicKey.export({ type: "spki", format: "pem" });
  fs.writeFileSync(path.join(__dirname, "..", "lib", "releasekey.js"),
    "// The release signing key's public half (tools/make_release_key.js). The launcher only\n" +
    "// trusts manifests signed by the matching private key.\n" +
    `module.exports = ${JSON.stringify(pub)};\n`);
  console.log("private key: " + keyPath + " (back it up; never commit it)");
  console.log("public key written to lib/releasekey.js");
}

module.exports = { DEFAULT_KEY };
if (require.main === module) main(process.argv[2]);
