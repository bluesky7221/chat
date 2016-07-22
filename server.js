//express 사용
var express = require('express');
var app = express();
//http를 socket.io로 감쌈
var http = require('http').Server(app);
//실시간 data 교환 가능
var io = require('socket.io')(http);
//rabbitMQ 사용
var amqp = require('amqplib/callback_api');
//토픽 방식을 사용
var ex = "topic";
//클라이언트에게 client.html을 보여줌
app.get("/", function(req,res){
  res.sendfile("client.html");
});
//id 저장
var count = 0;
var nickName = [];
var socketId = [];
//연결부
//서버가 닫히거나 여는데 실패하면 재연결
var count=1; //user 카운터
var amqpConn = null; //연결된 amqp를 전역으로 사용하여 publish, comsumer에서 채널 만들 때 사용
//name으로 해당 i 찾아주는 함수
function findName(name) {
  for ( i = 0; i < nickName.length; i++)
  {
    if (name == nickName[i])
    {
      return i;
    }
  }
  return -1;
}
//socket.id로 해당 i 찾아주는 함수
function findId(socket_id) {
  for ( i = 0; i < socketId.length; i++)
  {
    if (socket_id == socketId[i])
    {
      return i;
    }
  }
  return -1;
}
//amqp 연결 및 socket.io 연결
function start() {
  amqp.connect('amqp://localhost', function(err, conn) {
    if (err) { //amqp.connect 예외처리 -> 재시작
      console.error("[AMQP]", err.message);
      return setTimeout(start, 1000);
    }
    conn.on("error", function(err) { //conn 예외처리
      if (err.message !== "Connection closing") {
        console.error("[AMQP] conn error", err.message);
      }
    });
    conn.on("close", function() { //닫혔을 때 예외처리 -> 재시작
      console.error("[AMQP] reconnecting");
      return setTimeout(start, 1000);
    });

    console.log("[AMQP] connected");
    amqpConn = conn;

    //socket.io 연결
    io.on('connection', function(socket){
      console.log('user connected: ', socket.id);
      var name = "user" + count++; //user 이름
      //user name을 change name이란 명령으로 접속한 클라이언트에게 보냄
      io.to(socket.id).emit('change name', name);
      //서버 가동 시작 후 연결된 아이디 저장
      nickName[count] = name;
      socketId[count] = socket.id;
      count++;
      //클라이언트가 접속 해제시
      socket.on('disconnect', function(){
        var disc_msg = nickName[findId(socket.id)] + "님이 퇴장하셨습니다";
        //접속 해제할 때 아이디 값도 날려버림
        io.emit('receive disconnected', disc_msg);
        if (findId(socket.id) != -1)
        {
          nickName[findId(socket.id)] = "undefined";
          socketId[findId(socket.id)] = "undefined";
        }
        console.log('user disconnected: ', socket.id);
      });
      //클라이언트가 메시지를 보냈을 때
      socket.on('send message', function(name,text){
        var msg = name + ' : ' + text;
        //메시지 발행
        publish(ex, "message", new Buffer(msg));
        //console.log("message_publish");
      });
      socket.on('send change name', function(c_name) {
        if (findId(socket.id) != -1)
        {
          nickName[findId(socket.id)] = c_name;
        }
        //메시지 발행
        publish(ex, "change name",  new Buffer(c_name));
        //console.log("change_name_publish");
      });
      socket.on('show users', function(name, number) {
        var show_number = "show." + number;
        //메시지 발행
        publish(ex, show_number, new Buffer(name));
        //console.log("change_name_publish");
      });
    });
    //포트 3001에서 listen
    http.listen('3022', function(){
      console.log("server on!");
    });

    whenConnected();
  });
}

//발행 -> exchange에서 binding해서 queues 생성
function whenConnected() {
  startPublisher();
  startWorker();
}

var pubChannel = null;
var offlinePubQueue = [];
function startPublisher() {
  //createConfirmChannel이란 confirmation mode를 사용하는 채널을 만드는것
  //확인 모드는 서버에 의해 acked or nacked 된 발행 메시지를 필요 -> 처리됨을 나타냄
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
      //offlinePubQueue는 앱이 offline이면 메시지를 보낼 수 없는 내부적 큐
      //큐에 메시지가 더해진다면 앱이 큐를 확인
      var m = offlinePubQueue.shift();
      if (!m) break;
      publish(m[0], m[1], m[2]);
    }
  });
}

//publish msg
//만약 연결이 끊키면 연결됬을 때 큐에 저장해놨던 메시지들을 다 표시
function publish(exchange, routingKey, content) {
  try {
    //토픽으로 exchange 지정
    pubChannel.assertExchange(exchange, 'topic', {durable: true});
    //발행
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

//worker는 메시지를 보내기를 성공했을 때만 work
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
    //exchange 설정
    ch.assertExchange(ex, 'topic', {durable: true});
    //큐 생성
    ch.assertQueue('', { exclusive: false }, function(err, q) {
      if (closeOnErr(err)) return;
      ch.bindQueue(q.queue, ex, "message");
      //consumer set up
      ch.consume(q.queue, processMsg, { noAck: false });
      console.log("message Worker is started");
    });
    ch.assertQueue('', { exclusive: false }, function(err, q) {
      if (closeOnErr(err)) return;
      ch.bindQueue(q.queue, ex, "change name");
      //consumer set up
      ch.consume(q.queue, function(name) {
        console.log(socketId[findName(name.content.toString())] + " change name to " + name.content.toString());
        io.to(socketId[findName(name.content.toString())]).emit('change name', name.content.toString());
      }, { noAck: false });
      console.log("change name Worker is started");
    });

    ch.assertQueue('', { exclusive: false }, function(err, q) {
      if (closeOnErr(err)) return;
      ch.bindQueue(q.queue, ex, "show.#");
      //consumer set up
      ch.consume(q.queue, function(name) {
        var number = name.fields.routingKey;
        var users_msg = "";
        //모든 유저 표시 일때
        if (number.substring(5,8) == "all")
        {
          //console.log("all");
          for (i = 0; i < nickName.length; i++)
          {
            if (nickName[i] !== "" && nickName[i] !== "undefined")
              users_msg += nickName[i] + "<br>";
          }
        }
        else if (number.substring(5,number.length) === "")
        {
          //console.log("else if '' '' ");
          for (i = 0; i < nickName.length; i++)
          {
            if (nickName[i] !== "undefined" && nickName[i] !== "")
              users_msg += nickName[i] + "<br>";
          }
        }
        else {
          //console.log("else");
          var n = number.substring(5,number.length);
          //숫자값 분리
          var nn = parseInt(n);
          if (nn <= nickName.length)
          {
            for (i = 0; i < nn; i++)
            {
              if (nickName[i] !== "" && nickName[i] !== "undefined")
                users_msg += nickName[i] + "<br>";
            }
          }
        }
        //console.log("number = " + number);
        //console.log("users_msg" + users_msg);
        console.log(socketId[findName(name.content.toString())] + " select show users");
        io.to(socketId[findName(name.content.toString())]).emit('receive users', users_msg);
      }, { noAck: false });
      console.log("show users Worker is started");
    });

    //process msg
    //work를 부르고 함수가 끝날 때까지 대기
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

//consumer
//broker인 exchange에게 큐를 전해받아 일함
//PDF 생성 및 메시지를 다룸
function work(msg, cb) {
  //socket.io에 받은 msg를 receive message로 전달해서 상대방에게 전달 (모든 접속자에게 뿌려준다)
  io.emit('receive message', msg.content.toString());
  console.log(msg.content.toString());
  cb(true); // -> 무조건 ack 시킴
}

function closeOnErr(err) {
  if (!err) return false;
  console.error("[AMQP] error", err);
  amqpConn.close();
  return true;
}

start(); //실행 !!!!!!!!!!!!!!!!!
