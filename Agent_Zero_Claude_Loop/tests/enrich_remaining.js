const BASE_URL = 'http://localhost:3000';

async function run() {
  const r = await fetch(`${BASE_URL}/api/tasks`);
  const data = await r.json();
  const tasks = data.tasks || data;
  const pending = tasks.filter(t => t.enrichmentStatus === 'pending' && t.status !== 'done');

  console.log(`Remaining pending: ${pending.length}`);

  for (let i = 0; i < pending.length; i++) {
    const task = pending[i];
    console.log(`\n[${i+1}/${pending.length}] "${task.title.substring(0,55)}"`);
    console.log(`  Source: ${task.source} | From: ${task.from}`);

    const start = Date.now();
    try {
      const resp = await fetch(`${BASE_URL}/api/tasks/${task.id}/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(300000)
      });
      const result = await resp.json();
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      const t = result.task || result;
      console.log(`  Duration: ${dur}s`);
      console.log(`  Confidence: ${t.confidence || '?'}`);
      console.log(`  Summary: ${(t.summary || 'none').substring(0,100)}...`);
    } catch (e) {
      const dur = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`  FAILED after ${dur}s: ${e.message}`);
    }
  }
}

run().catch(e => console.error(e.message));
