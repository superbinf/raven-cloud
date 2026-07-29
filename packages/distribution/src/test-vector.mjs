export const snapshotVector = Object.freeze({
  schemaVersion: 1,
  tenant: { id: "TENANT-CHANGAN", name: "长安汽车" },
  deploymentId: "EDGE-CQ-001",
  version: 7,
  generatedAt: "2026-07-19T08:30:00.000Z",
  monitoringTargets: [{
    id: "TARGET-001",
    name: "长安汽车",
    targetType: "企业",
    owner: "安全运营中心",
    domains: ["example.com"],
    ips: ["192.0.2.10"],
    keywords: ["长安汽车"],
    enabled: true,
    updatedAt: "2026-07-19T08:00:00.000Z"
  }],
  sensitiveRecords: [],
  assetRecords: [],
  credentialSubscriptions: [],
  credentialRecords: [],
  darkWebEvents: [],
  assetReports: []
});

export const rootSecretVector = "0123456789abcdef0123456789abcdef";
export const ivVector = Uint8Array.from([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b
]);

// Hard-coded values make a byte-level protocol drift visible to every consumer.
export const expectedVector = Object.freeze({
  canonicalSha256: "64951f985db0f91c76b87e246c7d96d871e6db066e3601690b14d2ba97f53878",
  gzipSha256: "34655f9d2930e477dbae31e8ecd625a74b9f39dd4d460599d8fb71b20dc4f5f1",
  encryptionKeyHex: "c49b1fc96c7262401ca1f1f255a3d8b3b1fa21932a6962136d2971199a87bdd2",
  manifestKeyHex: "459f31ebb6b47862d8c94a198c2e902a98404a32004d613c09f40d235a98f9b4",
  contentSha256: "f10cdc0ebd1339cb8238d2e547bca8d6f73ba2ce9e8180ad6f3872698a14f24d",
  manifestSignature: "ea972e2c953f80e65097673d5695f724e097cc32fb485e3c04252d368d2dff62",
  contentSize: 396
});
