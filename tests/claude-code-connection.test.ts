import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const root = resolve(import.meta.dirname, "..");
function scenario(code: string, settings?: string, override = false) {
	const home = mkdtempSync(join(tmpdir(), "lh-connection-"));
	try {
		const executable = join(home, "claude");
		writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> '${home}/argv'
case "$*" in
--version) echo '2.1.310 (Claude Code)';;
'auth status') if [ -f '${home}/logged-out' ]; then echo '{"loggedIn":false}';
  elif [ -f '${home}/no-account' ]; then echo '{"loggedIn":true}';
  else echo '{"loggedIn":true,"email":"user@example.com","subscriptionType":"pro","orgId":"x","orgName":"y"}'; fi;;
'auth login --claudeai')
  echo 'Opening browser to sign in…'
  echo $$ >> '${home}/pids'; env > '${home}/env'
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
  exec sleep 30;;
esac
`);
		chmodSync(executable, 0o755);
		if (settings) writeFileSync(join(home, "claude-code.json"), settings.replaceAll("STUB", executable));
		const env = {
			...process.env, NODE_ENV: "test" as const, HOME: home, LH_DATA_DIR: home,
			LH_AUTH_FILE: join(home, "absent"), PATH: `${home}:/bin:/usr/bin`, LH_CLAUDE_CODE_TEST_NO_FIXED_DIRS: "1",
			ANTHROPIC_API_KEY: "poison", ANTHROPIC_BASE_URL: "poison", HTTPS_PROXY: "poison", CLAUDE_CONFIG_DIR: "poison",
		};
		delete (env as NodeJS.ProcessEnv).LH_CLAUDE_CODE_EXECUTABLE;
		if (override) (env as NodeJS.ProcessEnv).LH_CLAUDE_CODE_EXECUTABLE = executable;
		execFileSync(process.execPath, ["--import", join(root, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "--eval", `
const {default: assert} = await import('node:assert/strict');
const fs = await import('node:fs');
const home = ${JSON.stringify(home)}, executable = ${JSON.stringify(executable)};
const warnings = []; console.warn = (...args) => warnings.push(args.join(' '));
const connection = await import(${JSON.stringify(join(root, "src/server/claude-code-connection.ts"))});
const route = await import(${JSON.stringify(join(root, "app/api/claude-code/route.ts"))});
const loginRoute = await import(${JSON.stringify(join(root, "app/api/claude-code/login/route.ts"))});
const endpointRoute = await import(${JSON.stringify(join(root, "app/api/claude-code/endpoint/route.ts"))});
const settingsModule = await import(${JSON.stringify(join(root, "src/server/claude-code-settings.ts"))});
const c = {
  ...connection, putClaudeCodeConnection: route.PUT, postClaudeCodeLogin: loginRoute.POST,
  getClaudeCodeStatus: async () => (await route.GET(new Request('http://localhost'))).json()
};
const catalog = await import(${JSON.stringify(join(root, "src/server/model-catalog.ts"))});
const keys = await import(${JSON.stringify(join(root, "src/server/keys.ts"))});
const request = body => new Request('http://localhost/api/claude-code', {
  method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
});
const loginRequest = () => new Request('http://localhost/api/claude-code/login', {method:'POST', headers:{'Content-Type':'application/json'}});
try { ${code} } finally { c.resetClaudeLoginForTests(); }
`], { env, encoding: "utf8", timeout: 30_000 });
	} finally { rmSync(home, { recursive: true, force: true }); }
}
it("local and off immediately update status, catalogs, persistence and refusal", () => scenario(`
let response = await c.putClaudeCodeConnection(request({mode:'local', baseUrl:'ignored', token:'ignored'}));
assert.equal(response.status, 200);
let status = await response.json();
assert.equal(status.active, true); assert.equal(status.found,true); assert.equal(status.loggedIn,true);
assert.equal(status.version,'2.1.310 (Claude Code)');
assert.equal(fs.readFileSync(home+'/argv','utf8'),'--version\\nauth status\\n');
assert.deepEqual(await c.getClaudeCodeStatus(),status);
assert.deepEqual(status.account,{email:'user@example.com',subscriptionType:'pro'});
assert.deepEqual(JSON.parse(fs.readFileSync(home+'/claude-code.json','utf8')),{mode:'local',executable});
assert.ok(catalog.modelCatalog().models.some(m=>m.provider==='claude-code'));
assert.ok(catalog.catalogProviders().some(m=>m.id==='claude-code'));
const other = await import(${JSON.stringify(join(root, 'src/agent/models.ts'))} + '?connection-copy');
assert.notEqual(other.piModels(), (await import(${JSON.stringify(join(root, 'src/agent/models.ts'))})).piModels());
assert.equal(other.piModels().getProvider('claude-code') !== undefined,true);
response = await c.putClaudeCodeConnection(request({mode:'off'}));
assert.equal(response.status,200); assert.equal((await response.json()).active,false);
assert.equal(other.piModels().getProvider('claude-code'),undefined);
assert.equal(keys.providerKeyPresent('claude-code'),false);
assert.ok(!catalog.modelCatalog().models.some(m=>m.provider==='claude-code'));
assert.ok(!catalog.catalogProviders().some(m=>m.id==='claude-code'));
const {providerKeyMissing, CLAUDE_CODE_OFF_REFUSAL} = await import(${JSON.stringify(join(root, "src/core/settings.ts"))});
assert.deepEqual(providerKeyMissing('claude-code',['cheap']), {
  error:CLAUDE_CODE_OFF_REFUSAL,code:'provider_key_missing',provider:'claude-code',slots:['cheap']
});
assert.equal((await c.putClaudeCodeConnection(request({mode:'endpoint'}))).status,400);
for (const body of [null, [], {}, {mode:'unknown'}, {mode:'off',executable:''}]) assert.equal((await c.putClaudeCodeConnection(request(body))).status,400);
assert.equal((await c.putClaudeCodeConnection(new Request('http://localhost',{method:'PUT'}))).status,415);
`));
it("real env override wins and refuses all PUT bodies", () => scenario(`
const status = await c.getClaudeCodeStatus();
assert.equal(status.envOverride,true); assert.equal(status.mode,'local'); assert.equal(status.executable,executable);
assert.equal((await c.putClaudeCodeConnection(new Request('http://localhost',{method:'PUT'}))).status,409);
assert.equal(fs.existsSync(home+'/claude-code.json'),false);
const endpoint = await import(${JSON.stringify(join(root, "src/server/claude-code-endpoint.ts"))});
endpoint.writeEndpointConfig({baseUrl:'https://relay.example',token:'sentinel'});
assert.equal((await endpointRoute.DELETE(new Request('http://localhost',{method:'DELETE'}))).status,200);
assert.equal(fs.existsSync(home+'/claude-code.json'),false);
assert.equal(fs.existsSync(endpoint.endpointFile()),false);
`, undefined, true));
it("invalid executables never change settings or registration and only validation runs", () => scenario(`
await c.putClaudeCodeConnection(request({mode:'local'}));
const before = fs.readFileSync(home+'/claude-code.json','utf8');
const bad = home+'/bad'; fs.writeFileSync(bad, '#!/bin/sh\\necho ran > '+home+'/marker\\n'); fs.chmodSync(bad,0o644);
assert.equal((await c.putClaudeCodeConnection(request({mode:'local',executable:bad}))).status,400);
assert.equal(fs.existsSync(home+'/marker'),false);
fs.writeFileSync(bad,'#!/bin/sh\\necho "$*" >> '+home+'/badargv\\necho other\\n'); fs.chmodSync(bad,0o755);
assert.equal((await c.putClaudeCodeConnection(request({mode:'local',executable:bad}))).status,400);
assert.equal(fs.readFileSync(home+'/badargv','utf8'),'--version\\n');
assert.equal((await c.putClaudeCodeConnection(request({mode:'local',executable:'relative'}))).status,400);
assert.equal(fs.readFileSync(home+'/claude-code.json','utf8'),before); assert.equal(keys.providerKeyPresent('claude-code'),true);
`));
it("login streams URL, replaces only its own child and preserves the allowlist", () => scenario(`
assert.equal((await c.postClaudeCodeLogin(new Request('http://localhost',{method:'POST'}))).status,415);
assert.equal(fs.existsSync(home+'/pids'),false);
const first = await c.postClaudeCodeLogin(loginRequest()); assert.equal(first.status,200);
const expected = {state:'pending',url:'https://claude.com/cai/oauth/authorize?code=true&state=abc',error:null};
assert.deepEqual((await first.json()).login,expected);
assert.deepEqual((await c.getClaudeCodeStatus()).login,expected);
const pid = Number(fs.readFileSync(home+'/pids','utf8').trim());
const second = await c.postClaudeCodeLogin(loginRequest()); assert.deepEqual((await second.json()).login,expected);
for(let i=0;i<50;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,20));}catch{break;}}
assert.throws(()=>process.kill(pid,0));
assert.deepEqual((await c.getClaudeCodeStatus()).login,expected);
const {CHILD_ENV_ALLOWLIST,CC_CHILD_ENV} = await import(${JSON.stringify(join(root, "src/agent/claude-code/child-env.ts"))});
const childEnv = Object.fromEntries(fs.readFileSync(home+'/env','utf8').trim().split('\\n').map(line=>{
  const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)];
}));
// POSIX sh adds these itself; they were not supplied by the app.
for (const key of ['PWD','SHLVL','_']) delete childEnv[key];
assert.ok(Object.keys(childEnv).every(k=>[...CHILD_ENV_ALLOWLIST,...Object.keys(CC_CHILD_ENV)].includes(k)), JSON.stringify(childEnv));
assert.ok(childEnv.PATH.startsWith(home+':'));
`));
it("login exits before a URL return a private 502 failure", () => scenario(`
fs.writeFileSync(executable, '#!/bin/sh\\ncase "$*" in\\n--version) echo "2.1.310 (Claude Code)";;\\n*) echo private-output >&2; exit 1;;\\nesac\\n');
const response = await c.postClaudeCodeLogin(loginRequest());
assert.equal(response.status,502);
const {login} = await response.json();
assert.equal(login.state,'failed'); assert.equal(login.url,null);
assert.ok(!login.error.includes('private-output')); assert.ok(!login.error.includes(home));
`));
it("saved local and endpoint modes boot without spawning and corrupt settings warn once privately", () => {
	for (const mode of ["local", "endpoint"]) scenario(`
assert.equal(keys.providerKeyPresent('claude-code'),true); assert.equal(fs.existsSync(home+'/argv'),false);
`, JSON.stringify({mode, executable: "STUB"}));
	scenario(`
assert.equal(keys.providerKeyPresent('claude-code'),false);
settingsModule.readClaudeCodeSettings(); settingsModule.readClaudeCodeSettings();
assert.equal(warnings.length,1); assert.ok(!warnings[0].includes(home));
`, '{broken');
});
it("discovery preserves first symlink path, skips invalid files and sorts nvm numerically", async () => {
	const home = mkdtempSync(join(tmpdir(), "lh-discovery-"));
	const originalEnv = { ...process.env };
	try {
		Object.assign(process.env, {
			HOME: home, LH_DATA_DIR: home, LH_AUTH_FILE: join(home,"absent"),
			PATH: `${home}:/bin:/usr/bin`, LH_CLAUDE_CODE_TEST_NO_FIXED_DIRS: "1",
		});
		delete process.env.LH_CLAUDE_CODE_EXECUTABLE;
		const { discoverClaudeExecutables } = await import("../src/server/claude-code-connection.ts");
		const make = (dir: string, executable = true) => {
			mkdirSync(dir,{recursive:true}); const file=join(dir,"claude");
			writeFileSync(file,"#!/usr/bin/env node\n"); chmodSync(file,executable?0o755:0o644); return file;
		};
		const target = make(join(home,"target"));
		mkdirSync(join(home,"link")); symlinkSync(target,join(home,"link/claude"));
		make(join(home,"bad"),false); mkdirSync(join(home,"directory/claude"),{recursive:true});
		const newest = make(join(home,".nvm/versions/node/v22.10.0/bin"));
		const oldest = make(join(home,".nvm/versions/node/v22.9.0/bin"));
		const npm = make(join(home,"npm"));
		const pathEnv = ["npm", "link", "target", "bad", "directory"].map(dir => join(home, dir)).join(":");
		assert.deepEqual(discoverClaudeExecutables({home,pathEnv,fixedDirs:[]}),[npm,join(home,"link/claude"),newest,oldest]);
		assert.ok(readFileSync(npm,"utf8").startsWith("#!/usr/bin/env node"));
	} finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env,originalEnv); rmSync(home,{recursive:true,force:true});
	}
});
it("endpoint registration reads stored credentials per stream and local replaces its deps", () => scenario(`
const boot = await import(${JSON.stringify(join(root, "src/server/claude-code-boot.ts"))});
const {piModels} = await import(${JSON.stringify(join(root, "src/agent/models.ts"))});
const {normalizeContext} = await import('@earendil-works/pi-ai');
const captured = [];
boot.setClaudeCodeLoadQueryForTests(async () => ({options}) => {
  captured.push(options);
  return {
    async *[Symbol.asyncIterator]() { yield {type:'result',subtype:'success',is_error:false}; },
    close() {}, interrupt: async () => {}
  };
});
const sentinel = 'endpoint-SENTINEL-test';
const put = async body => {
  const response = await route.PUT(request(body));
  const text = await response.text();
  assert.ok(!text.includes(sentinel)); assert.equal(response.status,200,text);
  return JSON.parse(text);
};
const stream = async () => {
  const models = piModels();
  const model = models.getModels('claude-code')[0];
  const context = normalizeContext({systemPrompt:'system',tools:[],messages:[{role:'user',content:'hello',timestamp:0}]});
  const events = models.streamSimple(model,context);
  for await(const event of events) assert.notEqual(event.type,'error',JSON.stringify(event));
  return captured.at(-1).env;
};
await put({mode:'endpoint',baseUrl:'https://relay.example/v1',token:sentinel});
let env = await stream();
assert.equal(env.ANTHROPIC_BASE_URL,'https://relay.example/v1'); assert.equal(env.ANTHROPIC_AUTH_TOKEN,sentinel);
await put({mode:'local',baseUrl:'https://ignored.example',token:'ignored'});
env = await stream();
assert.equal(Object.hasOwn(env,'ANTHROPIC_BASE_URL'),false); assert.equal(Object.hasOwn(env,'ANTHROPIC_AUTH_TOKEN'),false);
await put({mode:'endpoint'}); assert.equal((await stream()).ANTHROPIC_AUTH_TOKEN,sentinel);
const endpoint = await import(${JSON.stringify(join(root, "src/server/claude-code-endpoint.ts"))});
endpoint.writeEndpointConfig({baseUrl:'https://changed.example',token:'refreshed'});
assert.equal((await stream()).ANTHROPIC_AUTH_TOKEN,'refreshed');
assert.equal((await stream()).ANTHROPIC_BASE_URL,'https://changed.example');
assert.ok(!JSON.stringify(await c.getClaudeCodeStatus()).includes(sentinel));
const deleted = await endpointRoute.DELETE(new Request('http://localhost',{method:'DELETE'}));
assert.equal(deleted.status,200);
const text = await deleted.text(); assert.ok(!text.includes(sentinel));
assert.equal(JSON.parse(text).mode,'local'); assert.equal(fs.existsSync(endpoint.endpointFile()),false);
await put({mode:'endpoint',baseUrl:'https://relay.example',token:sentinel});
fs.writeFileSync(home+'/logged-out','');
const off = await endpointRoute.DELETE(new Request('http://localhost',{method:'DELETE'}));
assert.equal((await off.json()).mode,'off'); assert.equal(keys.providerKeyPresent('claude-code'),false);
`));
it("endpoint validation fails without modifying connection settings", () => scenario(`
const cases = [
  {mode:'endpoint'}, {mode:'endpoint',token:'sentinel'}, {mode:'endpoint',baseUrl:'https://relay.example'},
  {mode:'endpoint',baseUrl:'ftp://relay.example',token:'sentinel'},
  {mode:'endpoint',baseUrl:'http://example.com',token:'sentinel'},
  {mode:'endpoint',baseUrl:'https://relay.example',token:''},
  {mode:'endpoint',baseUrl:'https://relay.example',token:'invalid\\nvalue'},
];
for(const body of cases) {
  assert.equal((await route.PUT(request(body))).status,400);
  assert.equal(fs.existsSync(home+'/claude-code.json'),false);
  assert.equal(fs.existsSync(home+'/claude-endpoint.json'),false);
}
`));
it("all routes reject cross-origin requests before spawning or writing", () => scenario(`
const handlers = [route.GET,route.PUT,loginRoute.POST,endpointRoute.DELETE];
for(const handler of handlers) {
  for(const headers of [
    {origin:'https://other.example',host:'localhost'}, {origin:'null',host:'localhost'},
    {origin:'not a URL',host:'localhost'}, {'sec-fetch-site':'cross-site'}
  ]) {
    const response = await handler(new Request('http://localhost',{headers}));
    assert.equal(response.status,403);
    assert.deepEqual(await response.json(),{error:'cross-origin request refused'});
  }
}
assert.equal(fs.existsSync(home+'/argv'),false);
assert.equal(fs.existsSync(home+'/claude-code.json'),false);
assert.equal((await route.GET(new Request('http://localhost',{headers:{origin:'https://localhost',host:'localhost'}}))).status,200);
`));
it("status shares in-flight probes and caches for five seconds with mutation invalidation", () => scenario(`
const get = () => route.GET(new Request('http://localhost'));
let now = Date.now(); Date.now = () => now;
await Promise.all([get(),get()]); await get();
const probes = () => fs.readFileSync(home+'/argv','utf8').trim().split('\\n');
assert.deepEqual(probes(),['--version','auth status']);
await route.PUT(request({mode:'local'}));
const before = probes().length;
await get(); assert.equal(probes().length,before+2);
await get(); assert.equal(probes().length,before+2);
now += 5_001;
fs.writeFileSync(home+'/no-account','');
const status = await (await get()).json(); assert.equal(status.loggedIn,true); assert.equal(status.account,null);
assert.equal(probes().length,before+4);
c.invalidateClaudeStatusCacheForTests(); await get(); assert.equal(probes().length,before+6);
`));
