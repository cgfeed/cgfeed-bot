var http       = require('http');
var request    = require('request');
var nconf      = require('nconf');
var FeedParser = require('feedparser');
var moment     = require('moment');
var fs         = require('fs');
var sanitizer  = require('sanitizer');
//var github  = require('github');

// Fix to avoid socket choking...
var pool = new http.Agent(); pool.maxSockets = 4;

////////////////////////////////////////////////////////////////////////////////
// Setup nconf and load configuration
nconf.argv().env();
nconf.defaults({
    'CGFEED_JSON_PATH' : 'http://localhost:4000/data/feeds.json',
    'CGFEED_GIT_PATH'  : '../cgfeed.github.io/'
  });
var feeds_url      = nconf.get('CGFEED_JSON_PATH');
var site_repo_path = nconf.get('CGFEED_GIT_PATH');

console.log(feeds_url, site_repo_path);

////////////////////////////////////////////////////////////////////////////////
// Global tables of timestamps for each feed.
// Keeps track of the newest timestamp for each feed is, so we don't try to add
// posts we already have added.
var last_checked_lut = {}; // timestamps from last run
var curr_checked_lut = {}; // timestamps for current run


////////////////////////////////////////////////////////////////////////////////
// Global table with feed contents and counters to keep track of when we have
// gathered every feed.
var feed_table       = {};
var feed_count       = 0;
var feed_count_tot   = 0;

////////////////////////////////////////////////////////////////////////////////
// Constructs a valid Jekyll "blog post" filename for a specific feed entry
function construct_jekyll_filename( feed_data, post_data ) {

  var feed_url = feed_data.feed;
  var date_obj = moment(post_data.date);

  // Early exit if post is missing title or valid date
  if (!post_data.title || !date_obj.isValid())
    return null;

  // Keep track of a unix timestamp so we dont try to create posts we allready
  // have added to the site.
  var timestamp = date_obj.unix();

  if (last_checked_lut[feed_url] && timestamp <= last_checked_lut[feed_url])
    return null;

  if (curr_checked_lut[feed_url])
  {
    curr_checked_lut[feed_url] = Math.max(timestamp,
                                                curr_checked_lut[feed_url]);
  } else {
    curr_checked_lut[feed_url] = timestamp;
  }

  // Construct date string and clean up post and feed titles.
  var date_str        = date_obj.format('YYYY-MM-DD');

  var title_clean     = post_data.title.toLowerCase();
      title_clean     = title_clean.replace(/[^a-z ]/gi, '');
      title_clean     = title_clean.trim().replace(/ +/g, '_');

  var feed_name_clean = feed_data.title.toLowerCase();
      feed_name_clean = feed_name_clean.replace(/[^a-z ]/gi, '');
      feed_name_clean = feed_name_clean.replace(/ +/g, '_');

  var filename = date_str + '-' + feed_name_clean + '-' + title_clean + '.txt';

  return { filename : filename, timestamp : timestamp };

}

////////////////////////////////////////////////////////////////////////////////
// Callback fired when feeds are finished. Generates Jekyll post for each
// successfully parsed feed entry. Finally calls the deploy function.
function generate_files() {
    
    for (var i in feed_table) {

      console.log("---\nFeed:", i);

      for (var p = 0; p < feed_table[i].posts.length; p++) {

        var post_data = feed_table[i].posts[p];
        var blob = construct_jekyll_filename( feed_table[i], post_data );
        if (blob == null)
          continue;

        var post_filename  = blob.filename;
        var post_timestamp = blob.timestamp;
        var post_path = site_repo_path + "_posts/" + post_filename;

        // Should not happen; but check if we tried to generate a previously
        // created file/post.
        if (fs.existsSync(post_path))
        {
          console.error(post_path + "already exist!");
        } else {

          // Construct file content, mostly YAML front matter.
          var post_content  = '---\n';
              post_content += 'title: > ' + sanitizer.escape(post_data.title) + '\n';
              post_content += 'blog: > ' + feed_table[i].title + '\n';
              post_content += 'blogurl: > ' + feed_table[i].site + '\n';
              post_content += 'link: > ' + post_data.link + '\n';
              post_content += 'timestamp: ' + post_timestamp + '\n';
              post_content += '---\n';

          fs.writeFileSync(post_path, post_content);
          console.log("Wrote:", post_path);
        }

      };
    };

    // todo write curr
    //console.log(curr_checked_lut);
    //last_checked_lut = curr_checked_lut;

    // todo deploy changes

}

////////////////////////////////////////////////////////////////////////////////
// Fetch and parse a RSS/Atom feed from the web.
// Stores results for each feed in feed_table, indexed by feed url.
// Finally calls generate_files when all feeds are done.
function fetch(feed_name, feed_data) {

  var feed_url = feed_data.feed;
  var feedparser = new FeedParser();
  var req = request(feed_url, {pool: pool});

  
  req.setHeader('user-agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36');
  req.setHeader('accept', 'text/html,application/xhtml+xml');
  req.on('error', function (err) {
    if (err) {
      console.log(err, feed_url, err.stack);
      if (err.code == 'ECONNRESET')
      {
        console.log("Retrying...");
        fetch(feed_name, feed_data);
      } else {
        return process.exit(1);
      }
    }
  });
  req.on('response', function(res) {

    if (res.statusCode != 200)
      return this.emit('error', new Error('Bad status code'));

    feed_table[feed_url] = feed_data;
    feed_table[feed_url].title = feed_name;
    feed_table[feed_url].posts = [];
    this.pipe(feedparser);
  });

  feedparser.on('error', function (err) {
    if (err) {
      console.log(err, feed_url, err.stack);
      return process.exit(1);
    }
  });
  feedparser.on('end', function () {

    feed_count += 1;
    console.log("Fetch progress: ", feed_count, "/", feed_count_tot);

    if (feed_count == feed_count_tot)
    {
      generate_files();
    }
  })
  feedparser.on('readable', function() {
    var post;
    while (post = this.read()) {
      feed_table[feed_url].posts.push(post);
    }

  });
}

////////////////////////////////////////////////////////////////////////////////
// Main entry point, request the feed list JSON file and start fetching feeds.
request(feeds_url,
  function (error, response, body) {

  console.log(error, response, body);

  if (!error && response.statusCode == 200) {

    try {

      feed_list = JSON.parse(body);

      // count feeds
      feed_count_tot = 0;
      feed_count     = 0;
      for (var i in feed_list) {
        feed_count_tot += 1;
      }

      for (var i in feed_list) {
          console.log("Fetching feed:", i);
          fetch(i, feed_list[i]);
      }

    } catch (e) {
      console.error("JSON parsing error:", e); 
    }
  }
})

console.log("123");


