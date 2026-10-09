/** Use the existing Vercel CLI login and existing project automation token.
 * Never prints, persists, creates, or changes credentials or protection settings.
 */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadVercelAuditAuth(origin) {
  if (origin !== 'https://moru-talksimul.vercel.app') throw new Error('Unapproved audit origin.');
  const project = JSON.parse(await readFile('.vercel/project.json', 'utf8'));
  if (project.projectName !== 'moru-talksimul') throw new Error('Unexpected linked project.');
  const cli = join(process.env.APPDATA ?? '', 'npm/node_modules/vercel/dist/vc.js');
  const response = spawnSync(process.execPath, [cli, 'api', `/v9/projects/${project.projectId}`, '--scope', 'nonamad5196s-projects'], {
    encoding: 'utf8', windowsHide: true, timeout: 90_000,
  });
  if (response.status !== 0) throw new Error('Could not load protected deployment authorization.');
  let metadata;
  try { metadata = JSON.parse(response.stdout); }
  catch { throw new Error('Invalid deployment metadata.'); }
  if (metadata.id !== project.projectId || metadata.ssoProtection?.deploymentType !== 'all') {
    throw new Error('Unexpected deployment identity or authentication policy.');
  }
  const bypass = Object.keys(metadata.protectionBypass ?? {}).find(key => metadata.protectionBypass[key].scope === 'automation-bypass');
  if (!bypass) throw new Error('No existing automation authorization available.');
  return { bypass, projectId: project.projectId };
}
