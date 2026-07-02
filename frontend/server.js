const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
    // Strip query parameters (like ?v=1.0) if they exist
    let reqUrl = req.url.split('?')[0];
    let filePath = '.' + reqUrl;
    if (filePath === './') filePath = './index.html';

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',             // <-- Added CSS!
        '.png': 'image/png',
        '.jpg': 'image/jpeg',           // <-- Added for stock images
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',        // <-- Added for icons
        '.mp4': 'video/mp4',            // <-- Added for video clips
        '.mp3': 'audio/mpeg',           // <-- Added for audio clips
        '.wav': 'audio/wav',            // <-- Added for audio clips
        '.json': 'application/json',
        '.wasm': 'application/wasm'     // Very important for our Rust engine!
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    // THESE ARE THE MAGIC HEADERS
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cache-Control', 'no-store, must-revalidate');

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('File not found: ' + filePath);
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
}).listen(8080, () => {
    console.log('iKlippa dev server running at http://localhost:8080');
});