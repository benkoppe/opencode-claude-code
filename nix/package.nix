{ lib, stdenv, nodejs_22, pnpm_11, pnpmConfigHook, fetchPnpmDeps }:

stdenv.mkDerivation (finalAttrs: {
  pname = "opencode-claude-code";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src ../scripts ../tests ../package.json ../pnpm-lock.yaml
      ../pnpm-workspace.yaml ../tsconfig.json ../LICENSE ../NOTICE
    ];
  };

  nativeBuildInputs = [ nodejs_22 pnpm_11 pnpmConfigHook ];
  pnpmDeps = fetchPnpmDeps {
    pnpm = pnpm_11;
    inherit (finalAttrs) pname version src;
    fetcherVersion = 4;
    hash = "sha256-yv+29RG+j6TCY2wClzyWvweZ3jjngJ6iw6M4mTkdqR4=";
  };

  # The OpenCode binary is not Node; the inert MCP process needs a real runtime.
  postPatch = ''
    patchShebangs tests/fake-claude.mjs
    substituteInPlace src/claude-cli.ts \
      --replace-fail 'env.OPENCODE_CLAUDE_CODE_NODE_COMMAND || "node"' \
        'env.OPENCODE_CLAUDE_CODE_NODE_COMMAND || "${nodejs_22}/bin/node"'
  '';

  buildPhase = ''
    runHook preBuild
    pnpm check
    pnpm build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/opencode-claude-code"
    cp -r dist/. "$out/lib/opencode-claude-code/"
    cp LICENSE NOTICE "$out/lib/opencode-claude-code/"
    runHook postInstall
  '';

  meta = {
    description = "Effect-native Claude Code subscription provider for OpenCode 2";
    license = lib.licenses.mit;
    platforms = lib.platforms.unix;
  };
})
