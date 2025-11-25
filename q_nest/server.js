// Minimal placeholder server to simulate q_nest running
const http = require('http');
const port = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ msg: 'q_nest placeholder' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(port, () => console.log(`q_nest placeholder server listening on ${port}`));
