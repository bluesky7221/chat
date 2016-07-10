var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var amqp = require('amqp');

app.get("/", function(req,res){
  res.sendfile("client.html");
});

var count=1;
var connection = amqp.createConnection({host: 'localhost'});

connection.on('error', function(e)
{
  console.log("Error from amqp: ", e);
});

connection.on('ready', function(){
  io.on('connection', function(socket){
    console.log('user connected: ', socket.id);
    var name = "user" + count++;
    io.to(socket.id).emit('change name', name);

    socket.on('disconnect', function(){
      console.log('user disconnected: ', socket.id);
    });

    socket.on('send message', function(name,text){
      var msg = name + ' : ' + text;
      console.log(msg);
      io.emit('receive message', msg);
    });
  });
});


http.listen('3001', function(){
  console.log("server on!");
});
