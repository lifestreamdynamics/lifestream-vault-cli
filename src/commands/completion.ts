import type { Command, Option } from 'commander';

const SAFE_COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

interface CommandNode {
  name: string;
  description: string;
  subcommands: CommandNode[];
  options: string[]; // e.g. ['--dir', '--limit', '--output']
}

/**
 * Recursively walk the Commander tree and produce a structured CommandNode tree.
 * Only names matching SAFE_COMMAND_NAME are included (shell injection guard).
 */
function collectCommandTree(cmd: Command): CommandNode[] {
  const nodes: CommandNode[] = [];
  for (const sub of cmd.commands) {
    const name = sub.name();
    if (!SAFE_COMMAND_NAME.test(name)) continue;

    // Collect long-form option flags from this command's declared options.
    const options: string[] = sub.options
      .map((o: Option) => o.long)
      .filter((flag): flag is string => typeof flag === 'string');

    nodes.push({
      name,
      description: sub.description() ?? '',
      subcommands: collectCommandTree(sub),
      options,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------

/**
 * Emit the bash case arm for a top-level command.
 * Handles COMP_CWORD == 2 (show subcommand names) and COMP_CWORD >= 3 (show
 * a flat list of options for the matched sub/sub-subcommand).
 */
function bashCaseArm(node: CommandNode, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}${node.name})`);

  if (node.subcommands.length > 0) {
    const subNames = node.subcommands.map(s => s.name).join(' ');
    lines.push(`${indent}  if [[ $COMP_CWORD -eq 2 ]]; then`);
    lines.push(`${indent}    COMPREPLY=($(compgen -W "${subNames}" -- "$cur"))`);
    lines.push(`${indent}  else`);

    // Third-level: match sub-subcommand name in COMP_WORDS[2] and show its options
    lines.push(`${indent}    case "$cmd2" in`);
    for (const sub of node.subcommands) {
      const allOpts = sub.options.join(' ');
      // Also include sub-subcommand names if this node has nested commands
      const deepNames = sub.subcommands.map(s => s.name).join(' ');
      const completions = [deepNames, allOpts].filter(Boolean).join(' ');
      lines.push(`${indent}      ${sub.name})`);
      if (completions) {
        lines.push(`${indent}        COMPREPLY=($(compgen -W "${completions}" -- "$cur"))`);
      }
      lines.push(`${indent}        ;;`);
    }
    lines.push(`${indent}    esac`);
    lines.push(`${indent}  fi`);
  } else if (node.options.length > 0) {
    // Leaf command with flags only
    const opts = node.options.join(' ');
    lines.push(`${indent}  COMPREPLY=($(compgen -W "${opts}" -- "$cur"))`);
  }

  lines.push(`${indent}  ;;`);
  return lines.join('\n');
}

export function generateBashCompletion(program: Command): string {
  const tree = collectCommandTree(program);
  const topLevelNames = tree.map(n => n.name).join(' ');

  const caseArms = tree.map(node => bashCaseArm(node, '    ')).join('\n');

  return `# Bash completion for lsvault
# Add to ~/.bashrc: eval "$(lsvault completion bash)"
_lsvault_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmd1="\${COMP_WORDS[1]:-}"
  local cmd2="\${COMP_WORDS[2]:-}"

  # Top-level completions
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${topLevelNames}" -- "$cur"))
    return
  fi

  # Second-level and deeper
  case "$cmd1" in
${caseArms}
  esac
}
complete -F _lsvault_completions lsvault
`;
}

// ---------------------------------------------------------------------------
// Zsh
// ---------------------------------------------------------------------------

function zshDescribeArray(nodes: CommandNode[], varName: string, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}local -a ${varName}`);
  lines.push(`${indent}${varName}=(`);
  for (const n of nodes) {
    // Escape single quotes in description
    const desc = n.description.replace(/'/g, "'\\''");
    lines.push(`${indent}  '${n.name}:${desc}'`);
  }
  lines.push(`${indent})`);
  return lines.join('\n');
}

function zshCaseArm(node: CommandNode, indent: string): string {
  const lines: string[] = [];
  lines.push(`${indent}${node.name})`);

  if (node.subcommands.length > 0) {
    lines.push(zshDescribeArray(node.subcommands, 'subcmds', indent + '  '));
    lines.push(`${indent}  if (( CURRENT == 3 )); then`);
    lines.push(`${indent}    _describe 'subcommand' subcmds`);
    lines.push(`${indent}  else`);
    // Third-level: show options for matched subcommand
    lines.push(`${indent}    case "$words[3]" in`);
    for (const sub of node.subcommands) {
      if (sub.options.length > 0 || sub.subcommands.length > 0) {
        lines.push(`${indent}      ${sub.name})`);
        if (sub.subcommands.length > 0) {
          lines.push(zshDescribeArray(sub.subcommands, 'deepcmds', indent + '        '));
          lines.push(`${indent}        if (( CURRENT == 4 )); then`);
          lines.push(`${indent}          _describe 'subcommand' deepcmds`);
          if (sub.options.length > 0) {
            const optSpecs = sub.options.map(o => `'${o}'`).join(' ');
            lines.push(`${indent}        else`);
            lines.push(`${indent}          _arguments ${optSpecs}`);
          }
          lines.push(`${indent}        fi`);
        } else if (sub.options.length > 0) {
          const optSpecs = sub.options.map(o => `'${o}'`).join(' ');
          lines.push(`${indent}        _arguments ${optSpecs}`);
        }
        lines.push(`${indent}        ;;`);
      }
    }
    lines.push(`${indent}    esac`);
    lines.push(`${indent}  fi`);
  } else if (node.options.length > 0) {
    const optSpecs = node.options.map(o => `'${o}'`).join(' ');
    lines.push(`${indent}  _arguments ${optSpecs}`);
  }

  lines.push(`${indent}  ;;`);
  return lines.join('\n');
}

export function generateZshCompletion(program: Command): string {
  const tree = collectCommandTree(program);

  const topLevelArray = zshDescribeArray(tree, 'toplevel', '  ');
  const caseArms = tree.map(node => zshCaseArm(node, '    ')).join('\n');

  return `# Zsh completion for lsvault
# Add to ~/.zshrc: eval "$(lsvault completion zsh)"
_lsvault() {
${topLevelArray}

  if (( CURRENT == 2 )); then
    _describe 'command' toplevel
    return
  fi

  case "$words[2]" in
${caseArms}
  esac
}
compdef _lsvault lsvault
`;
}

// ---------------------------------------------------------------------------
// Fish
// ---------------------------------------------------------------------------

/**
 * Escape a string for use inside a fish completion -d '...' description.
 * Fish uses single quotes and doesn't support backslash escapes within them,
 * so we just strip single quotes entirely.
 */
function fishDesc(s: string): string {
  return s.replace(/'/g, '');
}

export function generateFishCompletion(program: Command): string {
  const tree = collectCommandTree(program);
  const lines: string[] = [];

  // Helper: the names of all top-level commands (used in __fish_seen_subcommand_from guards)
  const topLevelNames = tree.map(n => n.name).join(' ');

  for (const node of tree) {
    // Top-level command — only show when no subcommand has been entered yet
    lines.push(
      `complete -c lsvault -n '__fish_use_subcommand' -a '${node.name}' -d '${fishDesc(node.description)}'`
    );

    if (node.subcommands.length > 0) {
      // Subcommand names — show when this top-level command is active and no sub-subcommand yet
      for (const sub of node.subcommands) {
        lines.push(
          `complete -c lsvault -n '__fish_seen_subcommand_from ${node.name}; and not __fish_seen_subcommand_from ${sub.subcommands.map(s => s.name).concat(node.subcommands.map(s => s.name)).join(' ')}' -a '${sub.name}' -d '${fishDesc(sub.description)}'`
        );

        // Options for this subcommand — show when top-level AND subcommand are both seen
        for (const opt of sub.options) {
          lines.push(
            `complete -c lsvault -n '__fish_seen_subcommand_from ${node.name}; and __fish_seen_subcommand_from ${sub.name}' -a '${opt}'`
          );
        }

        // Third-level sub-subcommands
        for (const deep of sub.subcommands) {
          lines.push(
            `complete -c lsvault -n '__fish_seen_subcommand_from ${node.name}; and __fish_seen_subcommand_from ${sub.name}' -a '${deep.name}' -d '${fishDesc(deep.description)}'`
          );
          for (const opt of deep.options) {
            lines.push(
              `complete -c lsvault -n '__fish_seen_subcommand_from ${node.name}; and __fish_seen_subcommand_from ${deep.name}' -a '${opt}'`
            );
          }
        }
      }
    } else {
      // Leaf top-level command — offer its own options when active
      for (const opt of node.options) {
        lines.push(
          `complete -c lsvault -n '__fish_seen_subcommand_from ${topLevelNames}' -f -a '${opt}'`
        );
      }
    }
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

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
