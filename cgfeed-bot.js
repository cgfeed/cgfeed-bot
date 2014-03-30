var http       = require('http');
var request    = require('request');
var nconf      = require('nconf');
var FeedParser = require('feedparser');
var moment     = require('moment');
var fs         = require('fs');
var sanitizer  = require('sanitizer');
var git        = require('gift');

// Fix to avoid socket choking...
var pool = new http.Agent(); pool.maxSockets = 4;

////////////////////////////////////////////////////////////////////////////////
// Setup nconf and load configuration
nconf.env().argv();
nconf.defaults({
    'CGFEED_JSON_PATH' : 'http://localhost:4000/data/feeds.json',
    'CGFEED_REPO_PATH' : '../cgfeed.github.io',
    'deploy'           : true,
    'interval'         : 60*60
  });
var feeds_url      = nconf.get('CGFEED_JSON_PATH');
var site_repo_path = nconf.get('CGFEED_REPO_PATH');
var dry_run        = !nconf.get('deploy');
var check_interval = nconf.get('interval');


////////////////////////////////////////////////////////////////////////////////
// Global tables of timestamps for each feed.
// Keeps track of the newest timestamp for each feed is, so we don't try to add
// posts we already have added.
var last_state = {}; // timestamps from last run
var curr_state = {}; // timestamps for current run


////////////////////////////////////////////////////////////////////////////////
// Global table with feed contents and counters to keep track of when we have
// gathered every feed.
var feed_table       = {};
var feed_count       = 0;
var feed_count_tot   = 0;


////////////////////////////////////////////////////////////////////////////////
// Setup site git repo
var repo = git(site_repo_path)

////////////////////////////////////////////////////////////////////////////////
// "Deploys" new generated post files to the github repo
function deploy( post_files, deploy_callback ) {

  repo.add(post_files, function (err_add) {
    if (err_add)
    {
      deploy_callback('Error while adding files to new deploy: ' + err_add );
      return;
    }

    repo.commit("Autocommit via cgfeed-bot " + moment().format('YYYY-MM-DD'),
      function (err_commit) {
        
        if (err_commit)
        {
          deploy_callback( 'Error while commiting deploy: ' + err_commit );
          return;
        }

        repo.remote_push('master', function (err_push) {

            if (err_push)
            {
              deploy_callback( 'Error while pushing on deploy: ' + err_push );
              return;
            }

            deploy_callback(null);

          });

      });
    
  });

}


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

  if (last_state[feed_url] && timestamp <= last_state[feed_url])
    return null;

  if (curr_state[feed_url])
  {
    curr_state[feed_url] = Math.max(timestamp,
                                                curr_state[feed_url]);
  } else {
    curr_state[feed_url] = timestamp;
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
    
    var written_files = [];

    for (var i in feed_table) {

      console.log("---\nFeed:", i);

      for (var p = 0; p < feed_table[i].posts.length; p++) {

        var post_data = feed_table[i].posts[p];
        var blob = construct_jekyll_filename( feed_table[i], post_data );
        if (blob == null)
          continue;

        var post_filename  = blob.filename;
        var post_timestamp = blob.timestamp;
        var post_path = site_repo_path + "/_posts/" + post_filename;

        // Should not happen; but check if we tried to generate a previously
        // created file/post.
        if (fs.existsSync(post_path))
        {
          console.error(post_path + " already exist!");
        } else {

          // Construct file content, mostly YAML front matter.
          var content  = '---\n';
              content += 'title: > ' + sanitizer.escape(post_data.title) + '\n';
              content += 'blog: > ' + feed_table[i].title + '\n';
              content += 'blogurl: > ' + feed_table[i].site + '\n';
              content += 'link: > ' + post_data.link + '\n';
              content += 'timestamp: ' + post_timestamp + '\n';
              content += '---\n';

          if (!dry_run) {
            fs.writeFileSync(post_path, content);
          }
          console.log("Wrote:", post_path);
          written_files.push( "/_posts/" + post_filename );
        }

      };
    };

    // write current fetch state to repo
    last_state = curr_state;
    curr_state = {};
    write_state();
    written_files.push('/_data/fetch_state.json');

    // deploy changes
    if (!dry_run) {
      deploy( written_files, function(err) {
        if (err)
        {
          console.error("Deploy error: ", err);
        } else {
          console.log("Deploy successful!");
          setTimeout(update_site, check_interval * 1000.0);
        }

      } );
    } else {

      console.log("Dry run, skipping deploy().");
      setTimeout(update_site, check_interval * 1000.0);

    }

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

function read_state () {

  try {
    last_state = JSON.parse(
      fs.readFileSync( site_repo_path + '/_data/fetch_state.json' ));
  } catch (e) {
    console.error("Error while reading last fetch state:", e ); 
  }
}

function write_state () {

  fs.writeFileSync( site_repo_path + '/_data/fetch_state.json',
    JSON.stringify( last_state ) );

}

////////////////////////////////////////////////////////////////////////////////
// Main entry point, request the feed list JSON file and start fetching feeds.
function update_site() {

  repo.remote_fetch("origin master", function (fetch_err) {

    if (fetch_err)
    {
      console.error("Error while fetching repo:", fetch_err);
      return;
    }

    // read latest state
    read_state();
    
    request( feeds_url,
      function (error, response, body) {

        if (!error && response.statusCode == 200) {

          console.log("Got feed list, parsing as JSON...");
          try {

            feed_list = JSON.parse( body );

            // count feeds
            feed_count_tot = 0;
            feed_count     = 0;
            for (var i in feed_list) {
              feed_count_tot += 1;
            }
            console.log("Feed list contains " + feed_count_tot + " feeds.");

            for (var i in feed_list) {
              console.log("Fetching feed:", i);
              fetch(i, feed_list[i]);
            }

          } catch (e) {
            console.error("Feed list JSON parsing error:", e); 
          }

        } else {
          console.error("Error requesting feed list:", error);
        }

    });
  });

}


console.log("Feed list URL:", feeds_url);
console.log("Site repo:", site_repo_path);
console.log("Dry run:", dry_run);
console.log("Fetch interval:", check_interval + "s");
update_site();





