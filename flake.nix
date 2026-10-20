{
  description = "Claude Code CLI provider for OpenCode 2";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
    in {
      packages = eachSystem (system: {
        default = nixpkgs.legacyPackages.${system}.callPackage ./nix/package.nix { };
      });
      checks = eachSystem (system: {
        package = self.packages.${system}.default;
      });
    };
}
