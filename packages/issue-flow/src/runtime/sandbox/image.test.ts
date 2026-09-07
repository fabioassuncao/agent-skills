import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The two sandbox images (phase 13, §14 stage 2).
 *
 * The last row of the §14 threat model asks for "a minimal image as the default,
 * the current one as `full`". Building either takes minutes and gigabytes, so
 * what is checked here is the split itself: that the default no longer carries
 * the toolchains the threat model calls surface, and that everything an agent
 * needs to take an issue to a Pull Request is still in it. A hardening that left
 * the default image unable to run `git` or `gh` would not be one.
 */

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../sandbox');

/**
 * The instructions of a Dockerfile, with the comments stripped.
 *
 * Both files explain in prose what they do and do not install, and matching
 * against that prose would let a file pass by talking about a tool it never
 * installs — or fail for explaining why it dropped one.
 */
function instructions(file: string): string {
  return readFileSync(join(SANDBOX_DIR, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

const minimal = instructions('Dockerfile.sandbox');
const full = instructions('Dockerfile.sandbox.full');

/** What the pipeline actually invokes inside a sandbox. */
const REQUIRED = [
  { name: 'git', match: /\bgit\b/ },
  { name: 'the GitHub CLI', match: /install[^\n]*\bgh\b/ },
  { name: 'Node.js 22', match: /setup_22\.x/ },
  { name: 'a C toolchain for native npm modules', match: /build-essential/ },
  { name: 'Claude Code', match: /claude\.ai\/install\.sh/ },
  { name: 'Codex', match: /@openai\/codex/ },
  { name: 'openssh-client', match: /openssh-client/ },
  { name: 'the entrypoint', match: /COPY entrypoint\.sh/ },
];

/** What phase 13 removes from the default image, and only from the default. */
const HEAVY = [
  { name: 'the Rust toolchain', match: /rustup|cargo install/ },
  { name: 'asciinema', match: /asciinema/ },
  { name: 'Bun', match: /bun\.sh\/install/ },
  { name: 'Playwright and Chromium', match: /playwright install chromium/ },
  { name: 'the AWS CLI', match: /awscli/ },
  { name: 'the Mermaid CLI', match: /mermaid-cli/ },
];

describe('the default sandbox image is the minimal one', () => {
  for (const { name, match } of REQUIRED) {
    it(`still installs ${name}`, () => {
      expect(minimal).toMatch(match);
    });
  }

  for (const { name, match } of HEAVY) {
    it(`no longer carries ${name}`, () => {
      expect(minimal).not.toMatch(match);
    });
  }

  it('grants no sudo, which no-new-privileges would make inert anyway', () => {
    expect(minimal).not.toMatch(/sudoers|NOPASSWD/);
  });

  it('still maps a non-root uid onto the tools in /root', () => {
    // Without this the container runs as the host uid and cannot read anything
    // installed above — the `--user` mapping stops working and every launch
    // fails on PATH rather than on a security flag.
    expect(minimal).toMatch(/useradd -u 1000/);
    expect(minimal).toMatch(/chmod -R 777 \/root/);
  });
});

describe('the full image keeps everything, for the repositories that need it', () => {
  for (const { name, match } of HEAVY) {
    it(`still carries ${name}`, () => {
      expect(full).toMatch(match);
    });
  }

  for (const { name, match } of REQUIRED) {
    it(`still installs ${name}`, () => {
      expect(full).toMatch(match);
    });
  }

  it('still derives the AWS CLI architecture instead of hardcoding x86_64', () => {
    // The phase 12 divergence that makes the image buildable on arm64.
    expect(full).toMatch(/dpkg --print-architecture/);
    expect(full).not.toMatch(/awscli-exe-linux-x86_64/);
  });
});
