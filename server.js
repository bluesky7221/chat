var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var amqp = require('amqplib/callback_api');

app.get("/", function(req,res){
  res.sendfile("client.html");
});

//서버가 닫히거나 여는데 실패하면 재연결
var count=1;
var amqpConn = null;
function start() {
  amqp.connect('amqp://localhost', function(err, conn) {
    if (err) {
      console.error("[AMQP]", err.message);
      return setTimeout(start, 1000);
    }
    conn.on("error", function(err) {
      if (err.message !== "Connection closing") {
        console.error("[AMQP] conn error", err.message);
      }
    });
    conn.on("close", function() {
      console.error("[AMQP] reconnecting");
      return setTimeout(start, 1000);
    });

    console.log("[AMQP] connected");
    amqpConn = conn;

    io.on('connection', function(socket){
      console.log('user connected: ', socket.id);
      var name = "user" + count++;
      io.to(socket.id).emit('change name', name);

      socket.on('disconnect', function(){
        console.log('user disconnected: ', socket.id);
      });

      socket.on('send message', function(name,text){
        var msg = name + ' : ' + text;
        //console.log(msg);
        publish("", "message", new Buffer(msg));
        //io.emit('receive message', msg);
      });
    });

    http.listen('3001', function(){
      console.log("server on!");
    });

    whenConnected();
  });
}

function whenConnected() {
  startPublisher();
  startWorker();
}

var pubChannel = null;
var offlinePubQueue = [];
function startPublisher() {
  amqpConn.createConfirmChannel(function(err, ch) {
    if (closeOnErr(err)) return;
    ch.on("error", function(err) {
      console.error("[AMQP] channel error", err.message);
    });
    ch.on("close", function() {
      console.log("[AMQP] channel closed");
    });

    pubChannel = ch;
    while (true) {
      var m = offlinePubQueue.shift();
      if (!m) break;
      publish(m[0], m[1], m[2]);
    }
  });
}

// method to publish a message, will queue messages internally if the connection is down and resend later
function publish(exchange, routingKey, content) {
  try {
    pubChannel.publish(exchange, routingKey, content, { persistent: true },
                       function(err, ok) {
                         if (err) {
                           console.error("[AMQP] publish", err);
                           offlinePubQueue.push([exchange, routingKey, content]);
                           pubChannel.connection.close();
                         }
                       });
  } catch (e) {
    console.error("[AMQP] publish", e.message);
    offlinePubQueue.push([exchange, routingKey, content]);
  }
}

// A worker that acks messages only if processed succesfully
function startWorker() {
  amqpConn.createChannel(function(err, ch) {
    if (closeOnErr(err)) return;
    ch.on("error", function(err) {
      console.error("[AMQP] channel error", err.message);
    });
    ch.on("close", function() {
      console.log("[AMQP] channel closed");
    });
    ch.prefetch(10);
    ch.assertQueue("message", { durable: true }, function(err, _ok) {
      if (closeOnErr(err)) return;
      ch.consume("message", processMsg, { noAck: false });
      console.log("Worker is started");
    });

    function processMsg(msg) {
      work(msg, function(ok) {
        try {
          if (ok)
            ch.ack(msg);
          else
            ch.reject(msg, true);
        } catch (e) {
          closeOnErr(e);
        }
      });
    }
  });
}

function work(msg, cb) {
  io.emit('receive message', msg.content.toString());
  console.log(msg.content.toString());
  cb(true);
}

function closeOnErr(err) {
  if (!err) return false;
  console.error("[AMQP] error", err);
  amqpConn.close();
  return true;
}

start();
