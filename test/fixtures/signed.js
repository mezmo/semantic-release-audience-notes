import {execFile} from 'node:child_process'
import {readFile, writeFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import path from 'node:path'

const run = promisify(execFile)

// Signs the next commit with a throwaway SSH key and turns on log.showSignature, so
// git prints a signature check ahead of every log and show the way it does for a
// user who verifies signatures. Resolves false where ssh-keygen is missing.
async function signCommits(cwd) {
  const key = path.join(cwd, '.git', 'test-signing-key')
  try {
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  } catch {
    return false
  }
  const allowed = path.join(cwd, '.git', 'allowed-signers')
  await writeFile(allowed, `test@example.com ${await readFile(`${key}.pub`, 'utf8')}`)

  for (const [name, value] of [
    ['gpg.format', 'ssh']
  , ['user.signingkey', `${key}.pub`]
  , ['gpg.ssh.allowedSignersFile', allowed]
  , ['commit.gpgsign', 'true']
  , ['log.showSignature', 'true']
  ]) await run('git', ['config', name, value], {cwd})
  return true
}

export {signCommits}
