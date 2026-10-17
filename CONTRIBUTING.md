# Contributing

Thanks for your interest in nx-polystack.

- **Issues** — bug reports and feature requests are welcome. For a bug, include the `pstack --version`,
  Node and Nx versions, the command you ran and its output.
- **Pull requests** — this repository is published from a separate development repository, so pull
  requests are not merged here directly. A good pull request is still the best way to propose a
  change: it is applied in development (crediting you as co-author) and shows up here in the next
  release, and the pull request is closed with a link to it.

## Working on the code

```bash
npm ci
npm test          # Jest, on virtual Nx trees
npm run lint
npm run build     # → dist/
npm i -g .        # try your build of the pstack CLI
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).
