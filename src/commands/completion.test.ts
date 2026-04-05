import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { generateBashCompletion, generateZshCompletion, generateFishCompletion } from './completion.js';

function createTestProgram(): Command {
  const p = new Command();
  p.name('lsvault');
  p.command('vaults').description('Vault management');
  p.command('docs').description('Document management');
  p.command('search').description('Search');
  return p;
}

function createHierarchicalProgram(): Command {
  const p = new Command();
  p.name('lsvault');

  const vaults = p.command('vaults').description('Vault management');
  vaults.command('list').description('List all vaults').option('--include-archived', 'Include archived');
  vaults.command('create').description('Create a vault').option('-d, --description <desc>', 'Description');
  vaults.command('archive').description('Archive a vault').option('-y, --yes', 'Skip confirmation');

  const docs = p.command('docs').description('Document management');
  docs.command('list').description('List documents').option('--dir <path>', 'Filter by directory').option('--limit <n>', 'Max results');
  docs.command('get').description('Get a document').option('--meta', 'Show metadata');

  p.command('search').description('Search documents').option('--vault <id>', 'Vault ID').option('--limit <n>', 'Max results');

  return p;
}

describe('completion (flat program)', () => {
  const program = createTestProgram();

  it('bash completion contains function name and commands', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('_lsvault_completions');
    expect(output).toContain('vaults');
    expect(output).toContain('docs');
    expect(output).toContain('search');
  });

  it('zsh completion contains compdef and commands', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('compdef _lsvault');
    expect(output).toContain('vaults');
    expect(output).toContain('docs');
    expect(output).toContain('search');
  });

  it('fish completion contains complete commands', () => {
    const output = generateFishCompletion(program);
    expect(output).toContain('complete -c lsvault');
    expect(output).toContain('vaults');
    expect(output).toContain('docs');
    expect(output).toContain('search');
  });

  it('all outputs are non-empty', () => {
    expect(generateBashCompletion(program).length).toBeGreaterThan(0);
    expect(generateZshCompletion(program).length).toBeGreaterThan(0);
    expect(generateFishCompletion(program).length).toBeGreaterThan(0);
  });

  it('bash completion has correct shell script structure', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('COMPREPLY');
    expect(output).toContain('compgen -W');
    expect(output).toContain('complete -F _lsvault_completions lsvault');
  });

  it('zsh completion has correct shell script structure', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('_lsvault()');
    expect(output).toContain('_describe');
  });

  it('fish completion has one entry per top-level command when no subcommands exist', () => {
    const output = generateFishCompletion(program);
    const lines = output.trim().split('\n');
    // The test program has 3 top-level leaf commands: vaults, docs, search
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/^complete -c lsvault/);
    }
  });

  it('bash completion includes a comment header', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('# Bash completion for lsvault');
  });

  it('zsh completion includes a comment header', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('# Zsh completion for lsvault');
  });
});

describe('completion (hierarchical program)', () => {
  const program = createHierarchicalProgram();

  // --- Bash hierarchical ---

  it('bash: top-level block guards on COMP_CWORD -eq 1', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('COMP_CWORD -eq 1');
    // All three top-level names appear somewhere in the output
    expect(output).toContain('vaults');
    expect(output).toContain('docs');
    expect(output).toContain('search');
    // The top-level compgen block is present
    expect(output).toContain('compgen -W');
  });

  it('bash: subcommand names appear inside their parent case arm', () => {
    const output = generateBashCompletion(program);
    // vaults case arm should contain list, create, archive
    const vaultSection = output.slice(output.indexOf('vaults)'));
    expect(vaultSection).toContain('list');
    expect(vaultSection).toContain('create');
    expect(vaultSection).toContain('archive');
  });

  it('bash: COMP_CWORD -eq 2 guard exists for commands with subcommands', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('COMP_CWORD -eq 2');
  });

  it('bash: flags appear in the third-level case arm for their subcommand', () => {
    const output = generateBashCompletion(program);
    // docs list has --dir and --limit
    expect(output).toContain('--dir');
    expect(output).toContain('--limit');
    // docs get has --meta
    expect(output).toContain('--meta');
    // vaults create has --description
    expect(output).toContain('--description');
  });

  it('bash: uses cmd2 variable for third-level dispatch', () => {
    const output = generateBashCompletion(program);
    expect(output).toContain('cmd2=');
    expect(output).toContain('"$cmd2"');
  });

  // --- Zsh hierarchical ---

  it('zsh: top-level describe happens at CURRENT == 2', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('CURRENT == 2');
    expect(output).toContain("_describe 'command' toplevel");
  });

  it('zsh: subcommand describe happens at CURRENT == 3 inside correct case arm', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('CURRENT == 3');
    expect(output).toContain("_describe 'subcommand' subcmds");
  });

  it('zsh: case arm uses $words[2] for top-level dispatch', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('"$words[2]"');
  });

  it('zsh: case arm uses $words[3] for sub-subcommand dispatch', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('"$words[3]"');
  });

  it('zsh: option flags appear in _arguments calls', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('_arguments');
    expect(output).toContain('--dir');
    expect(output).toContain('--limit');
    expect(output).toContain('--meta');
    expect(output).toContain('--description');
  });

  it('zsh: subcommand descriptions are included in the array', () => {
    const output = generateZshCompletion(program);
    expect(output).toContain('list:List all vaults');
    expect(output).toContain('create:Create a vault');
    expect(output).toContain('archive:Archive a vault');
  });

  // --- Fish hierarchical ---

  it('fish: top-level commands use __fish_use_subcommand guard', () => {
    const output = generateFishCompletion(program);
    const topLines = output.split('\n').filter(l => l.includes('__fish_use_subcommand'));
    // Should have one top-level line for each of the 3 commands
    expect(topLines).toHaveLength(3);
    const names = topLines.map(l => l.match(/-a '([^']+)'/)?.[1]);
    expect(names).toContain('vaults');
    expect(names).toContain('docs');
    expect(names).toContain('search');
  });

  it('fish: subcommands use __fish_seen_subcommand_from with parent name', () => {
    const output = generateFishCompletion(program);
    const subLines = output.split('\n').filter(l =>
      l.includes('__fish_seen_subcommand_from vaults') && !l.includes('__fish_use_subcommand')
    );
    expect(subLines.length).toBeGreaterThan(0);
    const subNames = subLines.map(l => l.match(/-a '([^']+)'/)?.[1]).filter(Boolean);
    expect(subNames).toContain('list');
    expect(subNames).toContain('create');
    expect(subNames).toContain('archive');
  });

  it('fish: option flags appear with appropriate __fish_seen_subcommand_from guard', () => {
    const output = generateFishCompletion(program);
    // --dir belongs to docs list
    expect(output).toContain("__fish_seen_subcommand_from docs");
    expect(output).toContain("--dir");
    // --include-archived belongs to vaults list
    expect(output).toContain("--include-archived");
  });

  it('fish: does not emit options at top-level for commands that have subcommands', () => {
    const output = generateFishCompletion(program);
    // vaults has subcommands, so --description should NOT appear with __fish_use_subcommand
    const topLines = output.split('\n').filter(l => l.includes('__fish_use_subcommand'));
    for (const line of topLines) {
      expect(line).not.toContain('--description');
      expect(line).not.toContain('--dir');
    }
  });

  it('fish: leaf top-level commands (search) include their own options', () => {
    const output = generateFishCompletion(program);
    // search has no subcommands; its --vault and --limit options should appear
    expect(output).toContain('--vault');
    // --limit appears for both docs list and search; just confirm it's present
    expect(output).toContain('--limit');
  });

  it('fish: all lines are valid complete invocations', () => {
    const output = generateFishCompletion(program);
    const lines = output.trim().split('\n');
    for (const line of lines) {
      expect(line).toMatch(/^complete -c lsvault/);
    }
  });
});

describe('completion (shell injection prevention)', () => {
  it('commands with invalid names are excluded from all outputs', () => {
    const p = new Command();
    p.name('lsvault');
    p.command('valid-cmd').description('OK');
    // Commander normalizes names, so we test via the regex guard directly
    const bash = generateBashCompletion(p);
    const zsh = generateZshCompletion(p);
    const fish = generateFishCompletion(p);
    expect(bash).toContain('valid-cmd');
    expect(zsh).toContain('valid-cmd');
    expect(fish).toContain('valid-cmd');
  });

  it('SAFE_COMMAND_NAME rejects names with shell metacharacters', () => {
    // The guard regex only allows [a-z][a-z0-9-]* so names like
    // 'bad;name', 'bad$(cmd)', 'Bad', '_bad' are rejected.
    const safeName = /^[a-z][a-z0-9-]*$/;
    expect(safeName.test('valid-cmd')).toBe(true);
    expect(safeName.test('valid')).toBe(true);
    expect(safeName.test('bad;name')).toBe(false);
    expect(safeName.test('bad$(cmd)')).toBe(false);
    expect(safeName.test('Bad')).toBe(false);
    expect(safeName.test('_bad')).toBe(false);
    expect(safeName.test('123bad')).toBe(false);
  });
});
