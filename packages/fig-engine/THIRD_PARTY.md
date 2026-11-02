Parts of `src/parser`, `src/renderer`, and `src/export` are adapted from
[`echobt/figma-mcp`](https://github.com/echobt/figma-mcp), commit
`0e0289a62f71cc0626d54e42b210615e85425b95`, itself a fork of
[`bilalba/fig-mcp`](https://github.com/bilalba/fig-mcp). Both are MIT licensed.
The license notice is preserved in `third-party/LICENSE-echobt`.

The binary canvas parser is provided by the `openfig-core` npm dependency,
version 0.4.1, from [`OpenFig-org/openfig-core`](https://github.com/OpenFig-org/openfig-core).
Its package declares the MIT license.

Bundled fonts used to render SVG and PNG previews:

- Rubik and Montserrat: copied from the user's local design project; original font families by [The Rubik Project](https://github.com/googlefonts/rubik) and [The Montserrat Project](https://github.com/JulietaUla/Montserrat), SIL Open Font License 1.1. Their OFL notices are in `assets/fonts/Rubik/OFL.txt` and `assets/fonts/Montserrat/OFL.txt`.
- Roboto and Inter: downloaded from the [Google Fonts repository](https://github.com/google/fonts), SIL Open Font License 1.1. Notices are in their respective font folders.
- Source Sans Pro: downloaded from the [Tor Project's Source Sans Pro font mirror](https://www.torproject.org/static/fonts/SourceSansPro/) with its SIL Open Font License 1.1 notice; original family by [Adobe](https://github.com/adobe-fonts/source-sans).

`Raptor V3 Premium` is a commercial font and is not bundled. Previews use Rubik as a temporary substitute while retaining the original font name in node metadata.
