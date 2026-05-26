# Global Development Rules

## Conversation Style
- Be concise and precise, no fluff
- Communicate in Chinese; code comments and commit messages in Chinese
- When I ask a question, answer it first, then take action
- When uncertain, ask me instead of assuming

## Code Quality
- Read related files in full before modifying, don't rely solely on search snippets
- Never introduce `any` type
- Prefer existing utility functions and patterns in the project
- Never delete or downgrade code to "fix" an issue

## Workflow
- Run relevant checks/tests after code changes
- Do not auto-commit unless I explicitly ask
- Do not auto-run build or full test suites
- Make only the minimum necessary change each time
- Prefer the edit tool over write when modifying existing files

## Safety
- Never execute `rm -rf`, `sudo`, `git reset --hard`, `git checkout .`
- Never modify .env, .git/, credentials or other sensitive files
- Run `git status` before committing
- Only `git add` files you modified, never use `git add -A`

## Git
- Commit messages in Chinese, format: `type: 中文描述`
- Add `fixes #<number>` for related issues
- Never force push
