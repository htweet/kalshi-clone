# Caddy 2.10 with the layer-4 module (TCP + TLS termination for the FIX gateway, CLONE_SPEC.md §39.6). Both base
# images are pinned by digest and the module by commit; Dependabot (docker) bumps the bases.
FROM caddy:2.10-builder@sha256:01668408cc26e2e00c9d067c30cb43b2ba14ad1f2808beda55503cb2a31f59dc AS build
RUN xcaddy build --with github.com/mholt/caddy-l4@1da0f2bd8fc82466b0a77656ac00c965b7a6bcb2

FROM caddy:2.10@sha256:c3d7ee5d2b11f9dc54f947f68a734c84e9c9666c92c88a7f30b9cba5da182adb
COPY --from=build /usr/bin/caddy /usr/bin/caddy
