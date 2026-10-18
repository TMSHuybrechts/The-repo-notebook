import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = { id: 'example/demo', owner: 'example', name: 'demo', fullName: 'example/demo', note: 'Mijn eigen notitie', aiVerdict: 'Bestaand Nederlands oordeel', aiProvider: 'ollama' };

test('API localizes errors and keeps verdict caching separate from language selection', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rn-i18n-'));
  let calls = 0;
  const ollama = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'test-local' }] }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const prompt = JSON.parse(raw).messages[0].content;
    calls += 1;
    res.end(JSON.stringify({ message: { content: prompt.includes('Answer in Dutch') ? 'Nieuw Nederlands oordeel' : 'New English verdict' } }));
  });
  let child;
  try {
    await writeFile(path.join(dir, 'notebook.json'), JSON.stringify({ repos: [repo] }));
    ollama.listen(0, '127.0.0.1');
    await once(ollama, 'listening');
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    child = spawn(process.execPath, ['server/index.js', '--production'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PORT: String(port), RN_DATA_DIR: dir, RN_AI_PROVIDER: 'ollama', RN_AI_MODEL: 'test-local', RN_OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}`, GITHUB_TOKEN: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) });
    const request = async (route, lang, body, extraHeaders = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': lang, ...extraHeaders }, body: JSON.stringify(body)
      });
      return { status: response.status, data: await response.json() };
    };
    assert.equal((await request('/api/notebook', 'en', { url: 'geen-url' })).data.error, 'The URL must include an owner and repository name.');
    assert.equal((await request('/api/notebook', 'nl-BE,nl;q=0.9', { url: 'geen-url' })).data.error, 'De URL moet een eigenaar en repositorynaam bevatten.');
    const denied = await request('/api/notebook', 'nl', {}, { Origin: 'https://untrusted.example' });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error, 'Verboden oorsprong.');
    const route = '/api/notebook/example/demo/verdict';
    assert.equal((await request(route, 'nl', {})).data.cached, true); // legacy verdicts were Dutch
    assert.equal(calls, 0);
    assert.equal((await request(route, 'en', {})).data.verdict, 'New English verdict');
    assert.equal((await request(route, 'en', {})).data.cached, true);
    assert.equal(calls, 1);
    assert.equal((await request(route, 'nl', { refresh: true })).data.verdict, 'Nieuw Nederlands oordeel');
    assert.equal((await request(route, 'nl', {})).data.cached, true);
    assert.equal(calls, 2);
    const saved = JSON.parse(await readFile(path.join(dir, 'notebook.json'), 'utf8')).repos[0];
    assert.equal(saved.note, repo.note);
    assert.equal(saved.aiVerdictLanguage, 'nl');
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await new Promise(resolve => ollama.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
