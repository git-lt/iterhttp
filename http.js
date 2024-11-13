/**
 * [http 简易HTTP静态服务器脚本]
 * 基本功能：
 * 1. 能开启web服务，加载各种web资源
 * 2. 能自动分配可用端口，也可以配置端口
 * 3. 能加载json文件并模拟网速
 * 4. 启动时能自动打开默认浏览器浏览，方便调试
 * 5. 支持常用文件的MIME类型
 * 6. 可配置主页
 * 7. 允许跨域请求，方便其它项目测试时调用模拟接口的JSON数据
 * 8. host默认为本地IP(方便生成二维码手机扫描预览)
 * 9. 支持304指定资源的缓存响应
 * 10. 支持对特定文件启用Gzip压缩
 * 11. 支持全局快捷命令调用
 * 12. 支持断点续传
 */
var http = require('http');        // Http服务器API
var fs = require('fs');            // 用于处理本地文件
var os = require('os');            //用于获取本地IP地址
var exec = require('child_process').exec; //用于打开默认浏览器
var path = require('path');     //用于处理路径和后缀
var url = require('url');       //用于解析get请求所带的参数
var zlib = require('zlib');     //用于文件GZip压缩

var argv = require("minimist")(process.argv.slice(2), {
  alias: {
    'port': 'p',
    'home': 'h',
    'homedir': 'd'
  },
  string: ['port', 'home', 'homedir']
});

var CONFIG, //默认配置
    HTTP,   //HTTP静态类
    log;    //日志打印

var log = function(txt){ console.log(txt); };

if (argv.help) {
  log("Usage:");
  log("  iter-http --help // print help information");
  log("  iter-http // random a port, current folder as root");
  log("  iter-http 8888 // 8888 as port");
  log("  iter-http -p 8989 // 8989 as port");
  log("  iter-http -h index.htm // index.htm as home page");
  log("  iter-http -d dist // dist as root");
  process.exit(0);
}

CONFIG = {
  homedir:argv.homedir || '',
  home: argv.home || 'index.html',
  port: argv['_'][0] || argv.port || 0,
  browser: true,
  fileMatch: /^(gif|png|jpg|js|css)$/ig, //指定需要缓存的文件的类型
  maxAge: 60*60*24*365, //缓存过期时间
  zipMatch: /css|js|html/ig,
};

HTTP = {
  init:function(){
    this.createServer();
  },
  _getIPAddress:function(){/* 获取本地IPv4的IP地址 */
    var ifaces = os.networkInterfaces();
    var ip = '';
    for (var dev in ifaces) {
      ifaces[dev].forEach(function (details) {
        if (ip === '' && details.family === 'IPv4' && !details.internal) {
          ip = details.address;
          return;
        }
      });
    }
    return ip || "127.0.0.1";
  },
  _openURL:function(pathSrc){/* 使用默认浏览器打开URL */
    switch (process.platform) {
    case "darwin":
      exec('open ' + pathSrc);
      break;
    case "win32":
      exec('start ' + pathSrc);
      break;
    default:
      exec('xdg-open ' + pathSrc);
    }
  },
  _getMIME:function(ext){/* 获取文件的MIME类型 */
    var types = {
      "css": "text/css",
      "gif": "image/gif",
      "html": "text/html",
      "ico": "image/x-icon",
      "jpeg": "image/jpeg",
      "jpg": "image/jpeg",
      "js": "text/javascript",
      "json": "application/json",
      "pdf": "application/pdf",
      "png": "image/png",
      "svg": "image/svg+xml",
      "swf": "application/x-shockwave-flash",
      "tiff": "image/tiff",
      "txt": "text/plain",
      "wav": "audio/x-wav",
      "wma": "audio/x-ms-wma",
      "wmv": "video/x-ms-wmv",
      "xml": "text/xml"
    };

    return types[ext] || 'application/octet-stream';
  },
  _getRange:function(str, size){
    if (str.indexOf(",") != -1) {
        return;
    }
    var range = str.split("-"),
        start = parseInt(range[0], 10),
        end = parseInt(range[1], 10);

    // Case: -100 返回最后的end个字节
    if (isNaN(start)) {
        start = size - end;
        end = size - 1;
    // Case: 100- 返回从start往后到end之间的字节
    } else if (isNaN(end)) {
        end = size - 1;
    }

    // Invalid
    if (isNaN(start) || isNaN(end) || start > end || end > size) {
        return;
    }

    return {start: start, end: end};
  },
  responseFile:function(pathName,req, res, ext, params, stat){ /* 读取文件流并输出 */
    var self = this, raw;
    

    // 告知服务器类型和版本
    res.setHeader("Server", "Node/V5");
    // 允许断点续传
    res.setHeader('Accept-Ranges', 'bytes');
    // 允许跨域调用
    res.setHeader("Access-Control-Allow-Origin", "*");
    // 添加文件MIME类型
    res.setHeader("Content-Type", self._getMIME(ext));

    // 添加过期时间
    if(ext.match(CONFIG.fileMatch)){
      var expires = new Date();
      expires.setTime(expires.getTime()+CONFIG.maxAge*1000);
      res.setHeader('Expires', expires.toUTCString());
      res.setHeader('Cache-Control','max-age='+CONFIG.maxAge);
    }

    // 添加Last-Modified头
    var lastModified = stat.mtime.toUTCString();
    res.setHeader('Last-Modified', lastModified);

    // 检测请求头是否携带 If-Modified-Since 信息，如果请求的文件的If-Modified-Since时间与最后修改时间相同，则返回304
    var ifModifiedSince = "if-modified-since";
    if(req.headers[ifModifiedSince] && lastModified == req.headers[ifModifiedSince]){
      res.setHeader(304, 'Not Modified');
      res.end();
      return;
    }

    var compressHandle = function(raw, statusCode, msg){
      var stream = raw;
      var acceptEncoding = req.headers['accept-encoding'] || "";
      var zipMatch = ext.match(CONFIG.zipMatch);

      if (zipMatch && acceptEncoding.match(/\bgzip\b/)) {
          res.setHeader("Content-Encoding", "gzip");
          stream = raw.pipe(zlib.createGzip());
      } else if (zipMatch && acceptEncoding.match(/\bdeflate\b/)) {
          res.setHeader("Content-Encoding", "deflate");
          stream = raw.pipe(zlib.createDeflate());
      }

      res.writeHead(statusCode, msg);

      stream.pipe(res);
    }

    if(req.headers['range']){
      var range = self._getRange(req.headers['range'], stat.size);

      if(range){
        res.setHeader('Content-Range', 'bytes ' + range.start + '-' +range.end +'/'+stat.size);
        res.setHeader('Content-Length', range.end - range.start+1);
        raw = fs.createReadStream(pathName, {"start": range.start, "end": range.end});
        compressHandle(raw, 206, 'Partial Content');
      }else{
        res.removeHeader('Content-Length');
        res.writeHeader(416, 'Request Range Not Satisfiable');
        res.end();
      }
    }else{
      raw = fs.createReadStream(pathName);

      if(ext == 'json' && params.delay){
        setTimeout(function(){
          compressHandle(raw, 200, 'OK');
        },params.delay);
      }else{
        compressHandle(raw, 200, 'OK');
      }
    }
    
  },
  route:function( pathName, req, res ){/* 路由到指定的文件并响应输出 */
    var self = this;
    fs.stat(pathName, function(err, stats){
      if(err){
        res.writeHead(404, "Not Found", {'Content-Type': 'text/plain'});
        res.write("This request URL " + pathName + " was not found on this server.");
        res.end();
      }else{
        if(stats.isDirectory()){
          pathName = path.join(pathName, '/', CONFIG.home);
          self.route(pathName, req, res);
        }else{
          var method = req.method,
              ext = path.extname(pathName), 
              params='';

          log(method+': '+pathName);// 打印请求日志

          ext = ext ? ext.slice(1) : 'unknown';

          // 如果是get请求，且url结尾为'/'，那么就返回 home 页
          if(method=='GET'){
            pathName.slice(-1) === '/' &&  (pathName = path.normalize(pathName + '/' +CONFIG.home));
            params = url.parse(req.url, true).query;
            self.responseFile.bind(self)(pathName,req, res, ext, params, stats);
          }else if(method == 'POST'){
            var _postData = "", _postMap = "";
            req.on('data', function (chunk){
                _postData += chunk;
            }).on("end", function (){
              params = require('querystring').parse(_postData);
              self.responseFile.bind(self)(pathName,req, res, ext, params, stats);
            });
          }else{
            self.responseFile.bind(self)(pathName,req, res, ext, params, stats);
          }
        }
      }
    });
  },
  createServer:function(){/* 创建一个http服务 */
    var server = http.createServer();
    server.listen(CONFIG.port!==0 ? CONFIG.port : 0);
    this._bindEvents(server);
  },
  _bindEvents:function(server){ /* 注册响应事件 */
    var self = this, defaultUrl = CONFIG.homedir ? CONFIG.homedir+'/'+CONFIG.home : CONFIG.home;
    // 注册监听端口启用事件
    server.on('listening', function() { 
      var port = server.address().port;
      log('Server running at '+ port);
      CONFIG.browser && self._openURL('http://'+self._getIPAddress()+':'+port+'/'+defaultUrl);
    })

    // 注册请求处理事件
    server.on('request', function(request, response) {
        // 解析请求的URL
        var oURL = url.parse(request.url);
        var pathName = oURL.pathname.slice(1);
        if(!pathName) pathName = defaultUrl;
        pathName = pathName ? (CONFIG.homedir?(CONFIG.homedir+'/'+pathName):pathName) : defaultUrl;
        self.route.bind(self)(pathName, request, response);
    if (path.normalize(decodeURI(request.url)) !== decodeURI(request.url)) {
        response.statusCode = 403;
        response.end();
        return;
    }
    });
  }
};

HTTP.init();



