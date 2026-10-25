import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

const root = resolve(import.meta.dirname, "..");
function scenario(code: string, settings?: string, override = false, prelude = "") {
	const home = mkdtempSync(join(tmpdir(), "lh-connection-"));
	try {
		const executable = join(home, "claude");
		writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$*" >> '${home}/argv'
case "$*" in
--version) echo '2.1.310 (Claude Code)';;
'auth status --json') if [ -f '${home}/logged-out' ]; then echo '{"loggedIn":false}';
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
${prelude}
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
assert.equal(fs.readFileSync(home+'/argv','utf8'),'--version\\nauth status --json\\n');
const {ok, probeError, ...getShape} = status;
assert.equal(ok,true); assert.equal(probeError,undefined);
assert.deepEqual(await c.getClaudeCodeStatus(),getShape);
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
  {mode:'endpoint',baseUrl:'https://relay.example',token:'has space'},
  {mode:'endpoint',baseUrl:'https://relay.example',token:'t\\u00f6ken'},
];
for(const body of cases) {
  assert.equal((await route.PUT(request(body))).status,400);
  assert.equal(fs.existsSync(home+'/claude-code.json'),false);
  assert.equal(fs.existsSync(home+'/claude-endpoint.json'),false);
}
`));
it("a URL-only endpoint PUT over unreadable stored credentials asks to re-enter the token", () => scenario(`
fs.writeFileSync(home+'/claude-endpoint.json','{"baseUrl":"https://relay.example","token":');
const response = await route.PUT(request({mode:'endpoint',baseUrl:'https://relay.example'}));
assert.equal(response.status,400);
assert.equal((await response.json()).error,'claude-code endpoint: existing endpoint credentials could not be read; re-enter the token');
assert.equal(fs.existsSync(home+'/claude-code.json'),false);
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
assert.deepEqual(probes(),['--version','auth status --json']);
await route.PUT(request({mode:'local'}));
const before = probes().length;
await get(); assert.equal(probes().length,before);
await get(); assert.equal(probes().length,before);
now += 5_001;
fs.writeFileSync(home+'/no-account','');
const status = await (await get()).json(); assert.equal(status.loggedIn,true); assert.equal(status.account,null);
assert.equal(probes().length,before+2);
c.invalidateClaudeStatusCacheForTests(); await get(); assert.equal(probes().length,before+4);
`));
it("rejected launch overrides never execute, including after an environment change", () => {
	for (const setup of [
		"process.env.LH_IGNORE_ENV_KEYS='1';",
		"Object.defineProperty(process,'platform',{value:'freebsd'});",
	]) scenario(`
const status = await c.getClaudeCodeStatus();
assert.equal(status.envOverride,true); assert.equal(status.active,false);
assert.equal(status.version,null);
delete process.env.LH_IGNORE_ENV_KEYS;
assert.equal((await loginRoute.POST(loginRequest())).status,400);
assert.equal(fs.existsSync(home+'/argv'),false);
`, undefined, true, setup);
});
it("Windows mutations refuse before spawning", () => scenario(`
for (const response of [await route.PUT(request({mode:'local'})), await loginRoute.POST(loginRequest())]) {
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'Claude Code provider is not supported on Windows'});
}
assert.equal(fs.existsSync(home+'/argv'),false);
`, undefined, false, "Object.defineProperty(process,'platform',{value:'win32'});"));
it("old global shapes are ignored by versioned boot and registration state", () => scenario(`
assert.equal((await route.PUT(request({mode:'local'}))).status,200);
assert.equal((await c.getClaudeCodeStatus()).active,true);
`, undefined, false, `
globalThis[Symbol.for('lh.claudeCodeBoot')] = {kind:'accepted',path:executable};
globalThis[Symbol.for('lh.claudeCodeRegistration')] = {generation:99,desired:{}};
`));
it("failed settings and endpoint writes preserve the previous working configuration", () => scenario(`
const endpoint = await import(${JSON.stringify(join(root, "src/server/claude-code-endpoint.ts"))});
await route.PUT(request({mode:'endpoint',baseUrl:'https://old.example',token:'old-token'}));
const oldEndpoint = fs.readFileSync(endpoint.endpointFile(),'utf8');
const oldSettings = fs.readFileSync(home+'/claude-code.json','utf8');
fs.unlinkSync(home+'/claude-code.json'); fs.mkdirSync(home+'/claude-code.json');
let response = await route.PUT(request({mode:'endpoint',baseUrl:'https://new.example',token:'new-token'}));
assert.equal(response.status,500); assert.equal(fs.readFileSync(endpoint.endpointFile(),'utf8'),oldEndpoint);
assert.equal(keys.providerKeyPresent('claude-code'),true);
fs.rmdirSync(home+'/claude-code.json'); fs.writeFileSync(home+'/claude-code.json',oldSettings);
fs.unlinkSync(endpoint.endpointFile()); fs.mkdirSync(endpoint.endpointFile());
response = await route.PUT(request({mode:'endpoint',baseUrl:'https://new.example',token:'new-token'}));
assert.equal(response.status,500); assert.equal(fs.readFileSync(home+'/claude-code.json','utf8'),oldSettings);
`));
it("captured collections from two module copies refuse streams after off", () => scenario(`
const boot = await import(${JSON.stringify(join(root, "src/server/claude-code-boot.ts"))});
let calls = 0;
boot.setClaudeCodeLoadQueryForTests(async () => { calls++; throw new Error('must not load'); });
await route.PUT(request({mode:'local'}));
const first = await import(${JSON.stringify(join(root, "src/agent/models.ts"))}+'?capture-first');
const second = await import(${JSON.stringify(join(root, "src/agent/models.ts"))}+'?guard-copy');
const collections = [first.piModels(),second.piModels()];
const model = collections[0].getModels('claude-code')[0];
// Disable in a third copy, leaving both captured collections untouched.
assert.equal((await route.PUT(request({mode:'off'}))).status,200);
const {normalizeContext} = await import('@earendil-works/pi-ai');
for (const models of collections) {
  const events = models.streamSimple(model,normalizeContext({systemPrompt:'',tools:[],messages:[{role:'user',content:'x',timestamp:0}]}));
  const result = await events.result();
  assert.equal(result.errorMessage,'claude-code: provider is off');
}
assert.equal(calls,0);
`));
it("stale saved executables fall back to discovery in GET, PUT and login", () => scenario(`
for (const exists of [false,true]) {
  const stale = home+'/stale';
  (await import(${JSON.stringify(join(root, 'src/agent/models.ts'))})).disableClaudeCodeProvider();
  if (exists) { fs.writeFileSync(stale,'#!/bin/sh\\necho wrong\\n'); fs.chmodSync(stale,0o755); }
  settingsModule.writeClaudeCodeSettings({mode:'local',executable:stale});
  c.invalidateClaudeStatusCacheForTests();
  const status = await c.getClaudeCodeStatus();
  assert.equal(status.executable,stale); assert.equal(status.discovered,executable); assert.equal(status.error,null);
  assert.equal(status.hint,'Saved Claude Code path is missing; choose the discovered one');
  const changed = await route.PUT(request({mode:'local'}));
  assert.equal(changed.status,200); assert.equal((await changed.json()).executable,executable);
  settingsModule.writeClaudeCodeSettings({mode:'local',executable:stale});
  assert.equal((await loginRoute.POST(loginRequest())).status,200);
  c.resetClaudeLoginForTests();
}
`));
it("successful URL-free login is idle and only login inherits desktop variables", () => scenario(`
for(const key of ['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) process.env[key]='desktop';
fs.writeFileSync(executable, '#!/bin/sh\\ncase "$*" in\\n--version) env > "' +
  home + '/version-env"; echo "Claude Code";;\\n"auth status --json") env > "' +
  home + '/status-env"; echo "{}";;\\nauth*) env > "' +
  home + '/login-env";;\\nesac\\n');
const response = await loginRoute.POST(loginRequest());
assert.equal(response.status,200); assert.deepEqual(await response.json(),{login:{state:'idle'}});
const versionEnv = fs.readFileSync(home+'/version-env','utf8'), loginEnv = fs.readFileSync(home+'/login-env','utf8');
for(const key of ['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) {
  assert.ok(!versionEnv.includes(key+'=')); assert.ok(loginEnv.includes(key+'=desktop'));
}
assert.equal((await c.getClaudeCodeStatus()).login.state,'idle');
const statusEnv = fs.readFileSync(home+'/status-env','utf8');
for(const key of ['DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) assert.ok(!statusEnv.includes(key+'='));
`));
it("corrupt or unreadable settings report a private error without fabricating off", () => scenario(`
await route.PUT(request({mode:'local'}));
for(const directory of [false,true]) {
  fs.rmSync(home+'/claude-code.json',{force:true,recursive:true});
  if(directory) fs.mkdirSync(home+'/claude-code.json'); else fs.writeFileSync(home+'/claude-code.json','{bad');
  const status = await c.getClaudeCodeStatus();
  assert.equal(status.error,'saved Claude settings could not be read');
  assert.equal(status.mode,'local'); assert.equal(status.active,true);
  assert.ok(!status.error.includes(home));
}
`));
it("mutations across module copies serialize and GET retries a changed settings generation", () => scenario(`
const endpoint = await import(${JSON.stringify(join(root, "src/server/claude-code-endpoint.ts"))});
const other = await import(${JSON.stringify(join(root, "src/server/claude-code-connection.ts"))}+'?mutex-copy');
endpoint.writeEndpointConfig({baseUrl:'https://old.example',token:'old'});
const slow = home+'/slow';
fs.writeFileSync(slow,'#!/bin/sh\\nif [ "$1" = "--version" ]; then touch "'+home+'/locked"; '+
  'while [ ! -f "'+home+'/unlock" ]; do sleep 0.01; done; echo "Claude Code"; else echo "{}"; fi\\n');
fs.chmodSync(slow,0o755);
const put = route.PUT(request({mode:'local',executable:slow}));
while(!fs.existsSync(home+'/locked')) await new Promise(resolve => setTimeout(resolve,5));
let deleteDone=false, loginDone=false;
const remove = other.deleteClaudeCodeEndpoint(new Request('http://localhost',{method:'DELETE'})).then(r=>{deleteDone=true;return r;});
const login = other.postClaudeCodeLogin(loginRequest()).then(r=>{loginDone=true;return r;});
await new Promise(resolve => setImmediate(resolve));
assert.equal(deleteDone,false); assert.equal(loginDone,false); assert.equal(fs.existsSync(endpoint.endpointFile()),true);
fs.writeFileSync(home+'/unlock',''); await put; await remove; await login; c.resetClaudeLoginForTests();
// Hold A's probe while writing B, then ensure GET retries rather than mixing A with B's mode.
(await import(${JSON.stringify(join(root, 'src/agent/models.ts'))})).disableClaudeCodeProvider();
const a = home+'/a', b=home+'/b';
fs.copyFileSync(executable,b); fs.chmodSync(b,0o755);
fs.writeFileSync(a,'#!/bin/sh\\nif [ "$1" = "--version" ]; then touch "' +
  home + '/started"; while [ ! -f "' +
  home + '/release" ]; do sleep 0.01; done; echo "A Claude Code"; else echo "{}"; fi\\n');
fs.chmodSync(a,0o755);
settingsModule.writeClaudeCodeSettings({mode:'local',executable:a}); c.invalidateClaudeStatusCacheForTests();
const pending = c.getClaudeCodeStatus();
while(!fs.existsSync(home+'/started')) await new Promise(resolve=>setTimeout(resolve,5));
settingsModule.writeClaudeCodeSettings({mode:'endpoint',executable:b}); fs.writeFileSync(home+'/release','');
const status = await pending;
assert.equal(status.mode,'endpoint'); assert.equal(status.executable,b); assert.equal(status.version,'2.1.310 (Claude Code)');
`));
it("auth status accepts logged-out JSON on exit one but version requires exit zero", () => scenario(`
fs.writeFileSync(executable,'#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "Claude Code"; '+
  ${JSON.stringify("else echo '{\"loggedIn\":false}'; exit 1; fi\n")});
let status = await c.getClaudeCodeStatus();
assert.equal(status.loggedIn,false); assert.equal(status.error,null);
fs.writeFileSync(executable,'#!/bin/sh\\necho "Claude Code"; exit 1\\n');
c.invalidateClaudeStatusCacheForTests();
status = await c.getClaudeCodeStatus(); assert.equal(status.version,null); assert.ok(status.error);
`));
it("captured providers reject real changes while equivalent boot and held-slot streams survive", () => scenario(`
const boot = await import(${JSON.stringify(join(root, "src/server/claude-code-boot.ts"))});
const models = await import(${JSON.stringify(join(root, "src/agent/models.ts"))});
const other = await import(${JSON.stringify(join(root, "src/agent/models.ts"))}+'?identity-copy');
const otherBoot = await import(${JSON.stringify(join(root, "src/server/claude-code-boot.ts"))}+'?boot-copy');
const {acquireClaudeCodeSlot} = await import(${JSON.stringify(join(root, "src/agent/claude-code/slots.ts"))});
const {normalizeContext} = await import('@earendil-works/pi-ai');
let calls=0;
const loadQuery = async () => () => {
  calls++;
  return {async *[Symbol.asyncIterator](){yield {type:'result',subtype:'success',is_error:false};},close(){},interrupt:async()=>{}};
};
boot.setClaudeCodeLoadQueryForTests(loadQuery);
await route.PUT(request({mode:'endpoint',baseUrl:'https://relay.example',token:'test-token'}));
const captured = other.piModels(), model = captured.getModels('claude-code')[0];
const context = normalizeContext({systemPrompt:'',tools:[],messages:[{role:'user',content:'x',timestamp:0}]});
await route.PUT(request({mode:'local'}));
assert.equal((await captured.streamSimple(model,context).result()).errorMessage,'claude-code: provider changed; retry');
assert.equal(calls,0);
process.env.LH_CLAUDE_CODE_MAX_CHILDREN='1';
for(const kind of ['same','off','changed']) {
  await route.PUT(request({mode:'local'}));
  const current = models.piModels(), currentModel = current.getModels('claude-code')[0];
  const release = await acquireClaudeCodeSlot();
  try {
    const events = current.streamSimple(currentModel,context);
    await new Promise(resolve=>setImmediate(resolve));
    if(kind==='same') { otherBoot.setClaudeCodeLoadQueryForTests(loadQuery); otherBoot.bootClaudeCodeProvider(); }
    if(kind==='off') other.disableClaudeCodeProvider();
    if(kind==='changed') other.enableClaudeCodeProvider(executable,{dataDir:home,loadQuery:async()=>loadQuery()});
    release();
    const result = await events.result();
    if(kind==='same') assert.notEqual(result.stopReason,'error',result.errorMessage);
    else assert.equal(result.errorMessage,kind==='off'?'claude-code: provider is off':'claude-code: provider changed; retry');
  } finally { release(); }
}
assert.equal(calls,1);
`));
it("registration is checked after a pending SDK load", () => scenario(`
const boot = await import(${JSON.stringify(join(root, "src/server/claude-code-boot.ts"))});
const models = await import(${JSON.stringify(join(root, "src/agent/models.ts"))});
const {normalizeContext} = await import('@earendil-works/pi-ai');
let finishLoad, calls=0;
boot.setClaudeCodeLoadQueryForTests(() => new Promise(resolve=>{finishLoad=resolve;}));
await route.PUT(request({mode:'local'}));
const collection=models.piModels(), model=collection.getModels('claude-code')[0];
const events=collection.streamSimple(model,normalizeContext({systemPrompt:'',tools:[],messages:[{role:'user',content:'x',timestamp:0}]}));
while(!finishLoad) await new Promise(resolve=>setImmediate(resolve));
models.disableClaudeCodeProvider(); finishLoad(()=>{calls++;});
assert.equal((await events.result()).errorMessage,'claude-code: provider is off'); assert.equal(calls,0);
`));
it("each probe deadline settles, escalates only its child, and permits retry", () => scenario(`
c.setClaudeProbeTimeoutsForTests(150,30);
for(const kind of ['version','auth']) {
  fs.writeFileSync(executable,'#!/bin/sh\\n'+
    (kind==='auth'?'if [ "$1" = "--version" ]; then echo "Claude Code"; exit 0; fi\\n':'')+
    'echo $$ >> "'+home+'/probe-pids"\\n'+
    (kind==='auth'?${JSON.stringify("echo '{\"loggedIn\":true}'\n")}:'echo "Claude Code"\\n')+
    "trap '' TERM; exec sleep 30\\n");
  c.invalidateClaudeStatusCacheForTests();
  for(let attempt=0;attempt<2;attempt++) {
    const response=await route.GET(new Request('http://localhost'));
    assert.equal(response.status,200); assert.ok((await response.json()).error);
    const pids=fs.readFileSync(home+'/probe-pids','utf8').trim().split('\\n').map(Number);
    const pid=pids.at(-1);
    for(let i=0;i<100;i++) { try {process.kill(pid,0);} catch {break;} await new Promise(resolve=>setTimeout(resolve,10)); }
    assert.throws(()=>process.kill(pid,0));
    assert.equal(pids.length,(kind==='auth'?2:0)+attempt+1);
  }
}
`));
it("PUT body limits and parsing happen before the mutation lock", () => scenario(`
let controller;
const blocked = new Request('http://localhost',{method:'PUT',headers:{'Content-Type':'application/json'},duplex:'half',
  body:new ReadableStream({start(c){controller=c;}})});
const waiting=route.PUT(blocked);
const second=await route.PUT(request({mode:'off'})); assert.equal(second.status,200);
controller.enqueue(new TextEncoder().encode('{"mode":"off"}')); controller.close(); assert.equal((await waiting).status,200);
assert.equal((await route.PUT(new Request('http://localhost',{method:'PUT',headers:{'Content-Type':'application/json'},
  body:' '.repeat(65537)}))).status,413);
assert.equal((await route.PUT(new Request('http://localhost',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{'}))).status,400);
`));
it("committed PUT and DELETE separate success from probe diagnostics", () => scenario(`
await route.PUT(request({mode:'local'}));
fs.writeFileSync(executable,'#!/bin/sh\\nif [ "$1" = "--version" ]; then echo "Claude Code"; else echo bad; fi\\n');
let response=await route.PUT(request({mode:'local'}));
let status=await response.json();
assert.equal(response.status,200); assert.equal(status.ok,true); assert.equal(status.error,null);
assert.equal(status.probeError,'unable to read login status');
status=await (await endpointRoute.DELETE(new Request('http://localhost',{method:'DELETE'}))).json();
assert.equal(status.ok,true); assert.equal(status.error,null); assert.ok(status.probeError);
status=await c.getClaudeCodeStatus(); assert.equal(status.error,'unable to read login status'); assert.equal(status.ok,undefined);
`));
it("status distinguishes configured registration from a discovered replacement", () => scenario(`
await route.PUT(request({mode:'local'}));
const replacement=home+'/replacement'; fs.mkdirSync(replacement); const candidate=replacement+'/claude';
fs.copyFileSync(executable,candidate); fs.chmodSync(candidate,0o755); fs.unlinkSync(executable);
process.env.PATH=replacement+':/bin:/usr/bin'; c.invalidateClaudeStatusCacheForTests();
const status=await c.getClaudeCodeStatus();
assert.equal(status.executable,executable); assert.equal(status.discovered,candidate); assert.equal(status.active,true);
assert.equal(status.found,false); assert.equal(status.version,'2.1.310 (Claude Code)');
assert.equal(status.hint,'Saved Claude Code path is missing; choose the discovered one');
const fixed=await (await route.PUT(request({mode:'local',executable:status.discovered}))).json();
assert.equal(fixed.executable,candidate); assert.equal(fixed.discovered,null); assert.equal(fixed.hint,null); assert.equal(fixed.ok,true);
await route.PUT(request({mode:'endpoint',baseUrl:'https://relay.example',token:'test-token'}));
const next=replacement+'/next'; fs.mkdirSync(next); const nextCandidate=next+'/claude';
fs.copyFileSync(candidate,nextCandidate); fs.unlinkSync(candidate); process.env.PATH=next+':/bin:/usr/bin';
const removed=await (await endpointRoute.DELETE(new Request('http://localhost',{method:'DELETE'}))).json();
assert.equal(removed.ok,true); assert.equal(removed.executable,nextCandidate); assert.equal(removed.discovered,null);

`));
