# Coomi

English | [中文](README.zh.md)

Coomi (`coomi`) is an open-source agent harness developed by TensorHub.

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

Coomi is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @coomi/coomi web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/coomi/coomi-desktop.git
cd coomi-desktop
pnpm install
pnpm run build
pnpm coomi web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/coomi/coomi-desktop/discussions).
- Add the [`coomi-plugin`](https://github.com/topics/coomi-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">Coomi Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
