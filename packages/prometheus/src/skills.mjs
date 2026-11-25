import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Skill } from '@opencode/plugin';
import { requireThat } from './util.mjs';

export function projectCheckInSkill() {
  const file = new URL('../skills/project-check-in/SKILL.md', import.meta.url);
  const source = fs.readFileSync(file, 'utf8');
  // This bundled file uses two plain, single-line frontmatter fields.
  const match = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  requireThat(match, 'The bundled project-check-in skill needs name, description, and Markdown content.');
  return {
    id: Skill.ID.make('project-check-in'), name: Skill.Name.make(match[1]),
    description: match[2], autoinvoke: true,
    path: Skill.Info.fields.path.make(fileURLToPath(file)), content: match[3].trim(),
  };
}
