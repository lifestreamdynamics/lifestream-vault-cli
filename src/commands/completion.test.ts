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

describe('completion', () => {
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

  it('fish completion has one entry per command', () => {
    const output = generateFishCompletion(program);
    const lines = output.trim().split('\n');
    // The test program has 3 top-level commands: vaults, docs, search
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
