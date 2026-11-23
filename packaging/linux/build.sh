#!/usr/bin/env bash
set -euo pipefail
version=$(node -p 'require("./package.json").version')
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -d "$stage/DEBIAN" "$stage/opt/blackcat-community" "$stage/lib/systemd/system" "$stage/usr/share/applications" packages
cp -a dist/. "$stage/opt/blackcat-community/"
install -m755 "$(command -v node)" "$stage/opt/blackcat-community/node"
node_home=$(dirname "$(dirname "$(realpath "$(command -v node)")")")
install -m644 "$node_home/LICENSE" "$stage/opt/blackcat-community/LICENSE-Node.txt"
install -m644 packaging/linux/*.service "$stage/lib/systemd/system/"
install -m755 packaging/linux/{postinst,prerm,postrm} "$stage/DEBIAN/"
cat > "$stage/DEBIAN/control" <<CONTROL
Package: blackcat-testing-community
Version: $version
Section: web
Priority: optional
Architecture: amd64
Maintainer: BlackCatSoftware <agent@blackcatsoftware.ru>
Depends: adduser, util-linux, libc6 (>= 2.28), libstdc++6, libatomic1, postgresql-16, postgresql-client-16
Description: BlackCat Testing Community test management
 Self-hosted test management with five active user accounts.
CONTROL
cat > "$stage/usr/share/applications/blackcat-community.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=BlackCat Testing Community
Exec=xdg-open http://localhost:3002
Terminal=false
Categories=Development;
DESKTOP
dpkg-deb --root-owner-group --build "$stage" "packages/blackcat-testing-community_${version}_amd64.deb"
