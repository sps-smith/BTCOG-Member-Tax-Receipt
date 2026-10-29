// Preserve the supplied JPEG bytes and embed them so each printable receipt is self-contained.
const fs = require('node:fs');
const path = require('node:path');
const signatureRoot = path.resolve(__dirname, '../src/webparts/memberContributions');
const jpeg = fs.readFileSync(path.join(signatureRoot, 'assets/georgia.jpg'));
if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) throw new Error('The signature asset must be a JPEG image.');
const source = [
  '// Generated from assets/georgia.jpg by scripts/embed-signature.cjs. Do not edit the image data by hand.',
  `export const receiptSignatureDataUrl = 'data:image/jpeg;base64,${jpeg.toString('base64')}';`,
  "export const receiptSignerTitle = 'Secretary/Treasurer';",
  "export const receiptSignerName = 'Georgia Pryce';",
  ''
].join('\n');
fs.writeFileSync(path.join(signatureRoot, 'domain/signature.ts'), source);
