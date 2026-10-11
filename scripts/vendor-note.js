// Rewrite the comment above `COPY ... vendor/` in NodeRed-Test's Dockerfile so
// it names the vendored commit and how far past the last tag it is. It gives
// the range for `git log` rather than copying the commit subjects in, so the
// note stays four lines and repeats nothing the log already says.
// Used by vendor-deploy.sh: node scripts/vendor-note.js <Dockerfile> <sha>
const fs = require("fs");
const { execSync } = require("child_process");

const [dockerfile, sha] = process.argv.slice(2);
if (!dockerfile || !sha) {
	console.error("usage: node scripts/vendor-note.js <Dockerfile> <sha>");
	process.exit(2);
}
const git = (args) => execSync(`git ${args}`, { encoding: "utf8" }).trim();
let tag = "";
try { tag = git("describe --tags --abbrev=0"); } catch {}
const count = tag ? Number(git(`rev-list --count ${tag}..HEAD`)) : 0;

const lines = [
	`# The vision nodes are pinned to a vendored tarball of unpublished commit`,
	`# ${sha}` + (tag ? `, ${count} commit${count === 1 ? "" : "s"} past ${tag} (git log ${tag}..${sha}).` : "."),
	`# REVERT to a registry version once that release is published; a vendored`,
	`# dependency is a temporary state, not the design.`,
];

const src = fs.readFileSync(dockerfile, "utf8").split("\n");
const copy = src.findIndex((l) => /^COPY .*vendor\/ /.test(l));
if (copy < 0) { console.error(`${dockerfile}: no COPY ... vendor/ line`); process.exit(1); }
let start = copy;
while (start > 0 && src[start - 1].startsWith("#")) start--;
src.splice(start, copy - start, ...lines);
fs.writeFileSync(dockerfile, src.join("\n"));
console.log(`${dockerfile}: vendor note now names ${sha}${tag ? `, ${count} commit${count === 1 ? "" : "s"} past ${tag}` : ""}`);
