import type { Command } from 'commander';

function collectCommandNames(cmd: Command, prefix = ''): string[] {
  const names: string[] = [];
  for (const sub of cmd.commands) {
    const full = prefix ? `${prefix} ${sub.name()}` : sub.name();
    names.push(sub.name());
    names.push(...collectCommandNames(sub, full));
  }
  return names;
}

export function generateBashCompletion(program: Command): string {
  const commands = collectCommandNames(program);
  return `# Bash completion for lsvault
# Add to ~/.bashrc: eval "$(lsvault completion bash)"
_lsvault_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="${commands.join(' ')}"
  COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
}
complete -F _lsvault_completions lsvault
`;
}

export function generateZshCompletion(program: Command): string {
  const commands = collectCommandNames(program);
  return `# Zsh completion for lsvault
# Add to ~/.zshrc: eval "$(lsvault completion zsh)"
_lsvault() {
  local -a commands
  commands=(${commands.map(c => `'${c}'`).join(' ')})
  _describe 'lsvault commands' commands
}
compdef _lsvault lsvault
`;
}

export function generateFishCompletion(program: Command): string {
  const commands = collectCommandNames(program);
  return commands.map(c =>
    `complete -c lsvault -n '__fish_use_subcommand' -a '${c}' -d '${c} command'`
  ).join('\n') + '\n';
}

export function registerCompletionCommands(program: Command): void {
  const completion = program.command('completion').description('Generate shell completion scripts');

  completion.command('bash')
    .description('Generate bash completion script')
    .action(() => {
      process.stdout.write(generateBashCompletion(program));
    });

  completion.command('zsh')
    .description('Generate zsh completion script')
    .action(() => {
      process.stdout.write(generateZshCompletion(program));
    });

  completion.command('fish')
    .description('Generate fish completion script')
    .action(() => {
      process.stdout.write(generateFishCompletion(program));
    });
}
