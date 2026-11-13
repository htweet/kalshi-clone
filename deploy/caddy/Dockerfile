# Caddy 2.10 with the layer-4 module (TCP + TLS termination for the FIX gateway, CLONE_SPEC.md §39.6). Both base
# images are pinned by digest and the module by commit; Dependabot (docker) bumps the bases.
FROM caddy:2.11-builder@sha256:6350162b3889ca32600b3c699c61572fa0eb3ad6b2a51874f19b158a7df77511 AS build
RUN xcaddy build --with github.com/mholt/caddy-l4@1da0f2bd8fc82466b0a77656ac00c965b7a6bcb2

FROM caddy:2.11@sha256:9c1b76fb701c1f77383d3124d9f626e38bcf83bc1255ed47475d4f2420701d03
COPY --from=build /usr/bin/caddy /usr/bin/caddy
