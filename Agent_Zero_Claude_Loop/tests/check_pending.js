async function main() {
  const r = await fetch('http://localhost:3000/api/tasks');
  const data = await r.json();
  const tasks = data.tasks || data;
  const pending = tasks.filter(t => t.enrichmentStatus === 'pending' && t.status !== 'done');
  console.log('Pending tasks: ' + pending.length);
  pending.forEach(t => console.log('  ' + t.id.substring(0,8) + ' | ' + t.source + ' | ' + t.title.substring(0,55)));
}
main();
