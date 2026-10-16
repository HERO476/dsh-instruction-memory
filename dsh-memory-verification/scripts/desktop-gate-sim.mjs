/**
 * Desktop-app plugin-gate simulation for dsh-instruction-memory.
 *
 * Runs the EXACT evaluatePluginCompatibility() logic from the desktop
 * archive's dsh-app-boot/lib/index.js against the plugin's real manifest.
 * The archive's dsh-app-boot@0.2.0-rc.2 is byte-identical (runtime JS) to the
 * npm release, so this is the same code path the desktop app executes at
 * profile boot. getDshRuntimeVersion() reads that package's own package.json
 * version — confirmed as 0.2.0-rc.2 — so the runtime version is passed
 * explicitly here instead of defaulting it.
 *
 *   node scripts/desktop-gate-sim.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const semver = createRequire(join(homedir(), '.dsh', 'profiles', 'node_modules', 'noop.js'))('semver')

/* ---- verbatim from desktop dsh-app-boot/lib/index.js:253-265 ---- */
function objectOf$1(value, field) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
	return value;
}
function runtimeVersionOf(value) {
	if (typeof value !== "string" || semver.valid(value) === null) throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`);
	return value;
}
function identityField(manifest, field) {
	const value = Object.hasOwn(manifest, field) ? manifest[field] : void 0;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh peers are incompatible`);
	return value;
}
/* ---- verbatim from desktop dsh-app-boot/lib/index.js:286-313 ---- */
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion) {
	runtimeVersionOf(runtimeVersion);
	const fields = objectOf$1(manifest, "Plugin manifest");
	if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
	const dependencies = objectOf$1(fields.peerDependencies, "Plugin manifest peerDependencies");
	const peers = {};
	for (const [name, range] of Object.entries(dependencies)) {
		if (typeof range !== "string") throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`);
		if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
		const requirement = [
			"workspace:^",
			"workspace:~",
			"workspace:*"
		].includes(range) ? runtimeVersion : range;
		if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
	}
	if (Object.keys(peers).length === 0) return void 0;
	const name = identityField(fields, "name");
	const version = identityField(fields, "version");
	const key = `${name}@${version}`;
	return {
		name,
		version,
		runtimeVersion,
		peers,
		exempted: (Object.hasOwn(exemptions, key) ? exemptions[key] : void 0)?.includes(runtimeVersion) === true
	};
}

/* ---- run against the plugin's live manifest ---- */
const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url))
const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
console.log('plugin manifest:', manifest.name + '@' + manifest.version)
console.log('peer range     :', manifest.peerDependencies['@deepseek-ai/dsh-system-prompt'])
console.log()

let fail = 0
const cases = [
  ['0.2.0-rc.2', 'desktop runtime (archive dsh-app-boot version)', true],
  ['0.2.1-alpha.4', 'current web host on this machine', true],
  ['0.1.5-rc.3', 'oldest live-tested host', true],
  ['0.1.2-rc.1', 'below the floor — control, must BLOCK', false],
]
for (const [v, note, expectAdmit] of cases) {
  const issue = evaluatePluginCompatibility(manifest, {}, v)
  const admitted = issue === undefined
  const ok = admitted === expectAdmit
  if (!ok) fail += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + v.padEnd(16) + (admitted ? 'ADMITTED' : 'BLOCKED ') + '  <- ' + note)
  if (!admitted) console.log('        peers refused: ' + JSON.stringify(issue.peers))
}
console.log()
console.log(fail === 0 ? 'GATE SIMULATION: ALL PASS' : 'GATE SIMULATION: ' + fail + ' FAILED')
process.exit(fail === 0 ? 0 : 1)
