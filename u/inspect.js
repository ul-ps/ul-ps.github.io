const fs = require('fs');
try {
  const d = JSON.parse(fs.readFileSync('rtdb_db.json', 'utf8'));
  const out = [];
  out.push('ROOT KEYS: ' + Object.keys(d).join(', '));
  if (d.products) {
    out.push('PRODUCTS TYPE: ' + typeof d.products);
    out.push('PRODUCTS IS ARRAY: ' + Array.isArray(d.products));
    out.push('PRODUCTS KEYS length: ' + Object.keys(d.products).length);
    if (!Array.isArray(d.products)) {
      out.push('PRODUCTS KEYS: ' + Object.keys(d.products).slice(0, 10).join(', '));
    } else {
      out.push('PRODUCTS LENGTH: ' + d.products.length);
      out.push('PRODUCTS SPARSE?: ' + Object.keys(d.products).length + ' vs ' + d.products.length);
    }
  } else {
    out.push('PRODUCTS KEY MISSING');
  }
  
  if (d.settings) {
    out.push('SETTINGS KEYS: ' + Object.keys(d.settings).join(', '));
  }
  
  fs.writeFileSync('out.txt', out.join('\n'));
} catch (e) {
  fs.writeFileSync('out.txt', 'Error: ' + e.message);
}
