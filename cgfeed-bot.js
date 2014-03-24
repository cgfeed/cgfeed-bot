// fix this:
var last_checked_lut = {}
var feeds_url = 'http://localhost:4000/data/feeds.json';

var http       = require('http');
var request    = require('request');
var nconf      = require('nconf');
var FeedParser = require('feedparser');
//var github  = require('github');

var pool = new http.Agent();
pool.maxSockets = 1;

var feed_count     = 0;
var feed_count_tot = 0;

function generate_files() {
  
  if (feed_count == feed_count_tot)
  {
    console.log("yup!!!");
  } else {
    console.log("not yet: ", feed_count, "/", feed_count_tot);
  }

}

function fetch(feed) {

  var feedparser = new FeedParser();
  var req = request(feed, {pool: pool});

  //req.setMaxListeners(50);
  req.setHeader('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36');
  req.setHeader('accept', 'text/html,application/xhtml+xml');
  req.on('error', function (err) {
    if (err) {
      console.log(err, feed, err.stack);
      if (err.code == 'ECONNRESET')
      {
        console.log("Retrying...");
        fetch(feed);
      } else {
        return process.exit(1);
      }
    }
  });
  req.on('response', function(res) {

    if (res.statusCode != 200) return this.emit('error', new Error('Bad status code'));

    this.pipe(feedparser);
  });

  feedparser.on('error', function (err) {
    if (err) {
      console.log(err, feed, err.stack);
      return process.exit(1);
    }
  });
  feedparser.on('end', function () {
    feed_count += 1;
    console.log("[ x ]", feed);
    generate_files();
  })
  feedparser.on('readable', function() {
    var post;
    while (post = this.read()) {
      // todo walk through the posts
      //console.log("post:", post.title);
    }

  });
}

request(feeds_url,
  function (error, response, body) {

  if (!error && response.statusCode == 200) {

    try {

      feed_list = JSON.parse(body);

      // count feeds
      for (var i in feed_list) {
        feed_count_tot += 1;
      }

      for (var i in feed_list) {
          console.log("Parsing feed:", i);
          fetch(feed_list[i].feed);
          //return;
      }

    } catch (e) {
      console.error("Parsing error:", e); 
    }
  }
})



