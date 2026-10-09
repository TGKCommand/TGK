import sharp from 'sharp'; import fs from 'fs';
const TEAL = '#2ABFAA';
// X5 / US-shape 2:1 (texture is sampled mirrored, so we mirror the art)
const us = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024">
 <rect width="2048" height="1024" fill="#f4f5f2"/>
 <rect x="14" y="14" width="2020" height="996" rx="40" fill="none" stroke="#111" stroke-width="22"/>
 <rect x="40" y="40" width="1968" height="150" fill="${TEAL}"/>
 <text x="1024" y="148" font-family="DejaVu Sans Condensed" font-weight="bold" font-size="112" fill="#fff" text-anchor="middle" letter-spacing="10">TGK MOTORSPORT</text>
 <text x="1024" y="760" font-family="DejaVu Sans Condensed" font-weight="bold" font-size="440" fill="#111" text-anchor="middle" textLength="1760" lengthAdjust="spacingAndGlyphs">TGK 001</text>
 <text x="1024" y="950" font-family="DejaVu Sans" font-size="96" fill="#333" text-anchor="middle" letter-spacing="8">TIME ATTACK</text>
</svg>`;
// CC / EU-shape 520x110 mm -> 2048x434
const eu = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="434">
 <rect width="2048" height="434" rx="30" fill="#f4f5f2"/>
 <rect x="8" y="8" width="2032" height="418" rx="28" fill="none" stroke="#111" stroke-width="14"/>
 <rect x="16" y="16" width="190" height="402" rx="18" fill="${TEAL}"/>
 <text x="111" y="330" font-family="DejaVu Sans Condensed" font-weight="bold" font-size="78" fill="#fff" text-anchor="middle">TGK</text>
 <text x="1127" y="330" font-family="DejaVu Sans Mono" font-weight="bold" font-size="290" fill="#111" text-anchor="middle" textLength="1720" lengthAdjust="spacingAndGlyphs">TGK-MS 26</text>
</svg>`;
await sharp(Buffer.from(us)).flip().png().toFile('/home/claude/w/plate_us.png');
await sharp(Buffer.from(eu)).png().toFile('/home/claude/w/plate_eu.png');
console.log('ok');
