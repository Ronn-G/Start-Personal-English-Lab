# License and provenance review needed

**BLOCKED — ORIGINAL SOURCE AND KOKORO MODEL PROVENANCE NOT ESTABLISHED**

No `LICENSE`, `NOTICE`, or `THIRD_PARTY_NOTICES` file exists in this repository. Git currently points
to `https://github.com/Ronn-G/Start-Personal-English-Lab.git`, while older history contains commits by
Jack Dang and later project work by Ngoc Long. Commit authorship and a Git remote do not establish a
copyright license, ownership transfer, or permission to redistribute the earlier source.

The Personal English Lab changes visible in later project commits include SQLite storage, backup,
audio, Listening, Speaking, and local hardening work. This identifies development history only; it
does not assert exclusive ownership of inherited code.

Direct npm package metadata currently reports MIT for Next.js, React, React DOM, Tailwind CSS and
`eslint-config-next`, and Apache-2.0 for Sharp and TypeScript. Those package licenses cover their own
packages, not this repository. A release needs a generated and reviewed third-party notice inventory,
including transitive packages and bundled license texts where required.

Kokoro Python packages, the ONNX model, and the voices binary are configured from machine-local paths
and are not committed here. Their exact source, version, license, model-card terms, voice-data terms,
and redistribution/commercial permissions have not been recorded. They require a separate evidence
review before any bundling or portable distribution.

The repository owner must:

1. Document the original source URL/revision and evidence of permission or ownership transfer.
2. Select and approve a repository license only after that evidence is complete.
3. Generate and review third-party notices for npm and Python dependencies.
4. Record the exact Kokoro package/model/voices sources, versions, hashes, and applicable terms.
5. Obtain legal review where public or commercial distribution is intended.

Until these items are complete, public/commercial release and portable redistribution remain blocked.
Do not add MIT, Apache, GPL, or another repository license by inference, and do not remove this block.
