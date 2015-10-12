var fs = require('fs')
var test = require('tap').test
var vtgeojson = require('vt-geojson')

var tl = require('vt-geojson/lib/tilelive-sources').tilelive
require('../')(tl)

var source = 'merge:?source=mbtiles://./test/two.mbtiles&source=mbtiles://./test/one.mbtiles&source=mbtiles://./test/three.mbtiles'

test('merging vector tiles with common layers', function (t) {
  var fc = { type: 'FeatureCollection', features: [] }
  vtgeojson(source, {
    minzoom: 10,
    maxzoom: 10,
    bounds: [
      -79.03564453124999,
      34.79576153473033,
      -77.58544921874999,
      36.00467348670187
    ]
  })
  .on('data', function (feature) {
    fc.features.push(feature)
  })
  .on('end', function () {
    var expected = JSON.parse(fs.readFileSync(__dirname + '/expected.geojson'))
    t.same(fc, expected)
    t.end()
  })
})
