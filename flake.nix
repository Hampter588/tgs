{
  description = "TGS — The Gathering Social desktop app";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let systems = [ "x86_64-linux" "aarch64-linux" ];
    in {
      packages = nixpkgs.lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.stdenvNoCC.mkDerivation {
          pname = "tgs"; version = "0.2.0";
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let relative = pkgs.lib.removePrefix (toString ./. + "/") (toString path);
              in relative == "package.json" || relative == "dist" || relative == "electron" || pkgs.lib.hasPrefix "dist/" relative || pkgs.lib.hasPrefix "electron/" relative;
          };
          nativeBuildInputs = [ pkgs.makeWrapper ];
          dontBuild = true;
          installPhase = ''
            test -f dist/index.html || { echo "Run npm ci && npm run build before nix build"; exit 1; }
            mkdir -p $out/share/tgs $out/bin $out/share/applications
            cp -r dist electron package.json $out/share/tgs/
            makeWrapper ${pkgs.electron}/bin/electron $out/bin/tgs --add-flags "$out/share/tgs"
            cat > $out/share/applications/tgs.desktop <<EOF
            [Desktop Entry]
            Name=TGS
            Comment=The Gathering Social
            Exec=$out/bin/tgs
            Terminal=false
            Type=Application
            Categories=Network;
            EOF
          '';
          meta = { description = "An ad-free Magic player community"; mainProgram = "tgs"; platforms = systems; };
        }; });
      devShells = nixpkgs.lib.genAttrs systems (system:
        let pkgs = import nixpkgs { inherit system; };
        in { default = pkgs.mkShell { packages = [ pkgs.nodejs pkgs.electron ]; }; });
    };
}
