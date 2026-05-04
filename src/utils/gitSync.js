// Sync a file to GitHub via Contents API. Called after every local write on Railway
// (ephemeral disk resets on redeploy; GitHub is the durable store).
// Fails silently — never blocks the pipeline.
const GITHUB_API = 'https://api.github.com';
const BRANCH = 'main';

export async function syncFileToGithub(filePath, content) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return; // not configured — no-op

  try {
    // GET current SHA (required by PUT to update an existing file)
    let sha = null;
    const getRes = await fetch(`${GITHUB_API}/repos/${repo}/contents/${filePath}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'xauusd-agent',
      },
    });
    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha ?? null;
    }

    const body = {
      message: `agent: sync ${filePath.split('/').pop()} ${new Date().toISOString().slice(0, 16)} UTC`,
      content: Buffer.from(content).toString('base64'),
      branch: BRANCH,
    };
    if (sha) body.sha = sha;

    const putRes = await fetch(`${GITHUB_API}/repos/${repo}/contents/${filePath}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'xauusd-agent',
      },
      body: JSON.stringify(body),
    });

    if (putRes.ok) {
      console.log(`[git-sync] ✓ ${filePath}`);
    } else {
      const errBody = await putRes.text().catch(() => '');
      if (putRes.status === 403) {
        console.warn('[git-sync] skipping — token lacks write permission (plans saved locally only)');
        console.warn('[git-sync] Fix: GitHub → Settings → Developer settings → Fine-grained tokens → Contents: Read & Write');
      } else if (putRes.status === 401) {
        console.warn('[git-sync] skipping — token invalid or expired. Update GITHUB_TOKEN in Railway env vars.');
      } else {
        console.warn(`[git-sync] failed ${filePath} HTTP ${putRes.status}: ${errBody.slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.warn(`[git-sync] error syncing ${filePath}: ${err.message}`);
  }
}
