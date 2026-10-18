// CloudFront Function, runtime cloudfront-js-2.0, viewer-request event.
// (a) 301-redirects www.lucaselia.dev to the apex, keeping the path and query.
// (b) Maps extensionless paths and trailing slashes to index.html, because Astro emits
//     every page as <path>/index.html (build.format "directory", trailingSlash "never").
// Unit-tested in infrastructure/test/site-viewer-request.test.ts.

var CANONICAL_HOST = "lucaselia.dev";

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls handler() directly.
function handler(event) {
  var request = event.request;
  var host = request.headers.host ? request.headers.host.value.toLowerCase() : "";
  if (host === "www." + CANONICAL_HOST) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: {
        location: {
          value: "https://" + CANONICAL_HOST + request.uri + queryString(request.querystring),
        },
        "cache-control": { value: "max-age=3600" },
      },
    };
  }
  request.uri = rewriteUri(request.uri);
  return request;
}

function rewriteUri(uri) {
  if (uri.charAt(uri.length - 1) === "/") {
    return uri + "index.html";
  }
  var last = uri.substring(uri.lastIndexOf("/") + 1);
  if (last.indexOf(".") === -1) {
    return uri + "/index.html";
  }
  return uri;
}

function queryString(querystring) {
  var parts = [];
  var keys = Object.keys(querystring || {});
  for (var i = 0; i < keys.length; i++) {
    var entry = querystring[keys[i]];
    var values = entry.multiValue ? entry.multiValue : [entry];
    for (var j = 0; j < values.length; j++) {
      var value = values[j].value;
      parts.push(value === "" ? keys[i] : keys[i] + "=" + value);
    }
  }
  return parts.length === 0 ? "" : "?" + parts.join("&");
}
