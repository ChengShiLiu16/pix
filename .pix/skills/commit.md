---
description: 生成 git commit message 并提交
---

根据当前 git 变更生成 commit message 并提交。

步骤：

1. 运行 `git diff --cached` 查看暂存区变更
2. 如果暂存区为空，运行 `git diff` 查看工作区变更，并询问我要暂存哪些文件
3. 分析变更内容，生成 commit message：
   - 格式：`<type>: <中文描述>`
   - type: feat / fix / refactor / docs / style / test / chore / perf
   - 描述用中文，简短精确，不超过 50 字符
   - body（可选）：如果变更需要解释原因，添加中文 body
4. 展示生成的 commit message 给我确认
5. 确认后执行 commit

不要自动 push。
