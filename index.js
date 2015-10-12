'use strict'

var url = require('url')
var zlib = require('zlib')

var async = require('async')
var mapnik = require('mapnik')

mapnik.register_default_input_plugins()

var normalizeHeaders = function (headers) {
  var _headers = {}

  Object.keys(headers).forEach(function (x) {
    _headers[x.toLowerCase()] = headers[x]
  })

  return _headers
}

/**
 * A tilelive source that merges sources.
 */
module.exports = function (tilelive, options) {
  var Merge = function (uri, callback) {
    var self = this

    this.uri = url.parse(uri, true)

    var sources = this.uri.query.source || this.uri.query.sources

    if (!Array.isArray(sources)) {
      return setImmediate(callback, new Error('Two or more sources must be provided: ' + JSON.stringify(uri)))
    }

    // TODO pass scale
    return async.map(sources, async.apply(tilelive.load), function (err, sources) {
      if (err) {
        return callback(err)
      }

      return async.map(sources, function (src, next) {
        return src.getInfo(next)
      }, function (err, info) {
        if (err) { return callback(err) }
        sources.forEach(function (src, i) {
          src.info = info[i]
        })

        self.sources = sources

        return callback(null, self)
      })
    })
  }

  Merge.prototype.getTile = function (z, x, y, callback) {
    var vtile = new mapnik.VectorTile(z, x, y)

    return async.map(this.sources, function (src, next) {
      var _z = z
      var _x = x
      var _y = y

      // overzooming support
      if (_z > src.info.maxzoom) {
        _z = src.info.maxzoom
        _x = Math.floor(x / Math.pow(2, z - _z))
        _y = Math.floor(y / Math.pow(2, z - _z))
      }

      var getTile = function (_z, _x, _y, callback) {
        return src.getTile(_z, _x, _y, function (err, data, headers) {
          if (err) {
            if (err.message.match(/Tile does not exist/)) {
              if (src.info.maskLevel && _z > src.info.maskLevel) {
                _z = src.info.maskLevel
                _x = Math.floor(x / Math.pow(2, z - _z))
                _y = Math.floor(y / Math.pow(2, z - _z))

                return getTile(_z, _x, _y, callback)
              }

              // include a value to be passed down the waterfall
              return callback(null, null, null)
            }

            return callback(err)
          }

          return callback(null, data, normalizeHeaders(headers))
        })
      }

      return async.waterfall([
        function (next) {
          return getTile(_z, _x, _y, function (err, data, headers) {
            // not all sources pass all arguments, so do this explicitly to
            // result in undefined values if necessary
            return next(err, data, headers)
          })
        },
        function (data, headers, next) {
          if (!data) {
            return next(null, null, headers)
          }

          if (headers['content-encoding'] === 'gzip') {
            return zlib.gunzip(data, function (err, pbf) {
              return next(err, pbf, headers)
            })
          }

          return next(null, data, headers)
        },
        function (buf, headers, next) {
          if (!buf) {
            return next(null, null, null)
          }

          var vt = new mapnik.VectorTile(_z, _x, _y)

          if (headers['content-type'] === 'application/x-protobuf') {
            vt.setData(buf)
            return next(null, vt, headers)
          }

          return mapnik.Image.fromBytes(buf, function (err, im) {
            if (err) {
              return next(err)
            }

            vt.addImage(im.encodeSync('webp'), src.info.id.replace(/\./g, '_'))
            return next(null, vt, headers)
          })
        }
      ], function (err, tile, headers) {
        if (err) {
          return next(err)
        }

        return next(null, [tile, headers])
      })
    }, function (err, data) {
      if (err) {
        return callback(err)
      }

      var headers = data
        .map(function (x) {
          return x[1]
        }).filter(function (x) {
          return !!x
        })

      // filter out empty tiles
      var tiles = data
        .map(function (x) {
          return x[0]
        }).filter(function (x) {
          return !!x
        })

      if (tiles.length === 0) {
        return callback(new Error('Tile does not exist'))
      }

      try {
        var layers = {}
        tiles.forEach(function (vt) {
          vt.names().forEach(function (layer) {
            var features = JSON.parse(vt.toGeoJSON(layer)).features
            layers[layer] = (layers[layer] || []).concat(features)
          })
        })
        for (var layer in layers) {
          var geojson = JSON.stringify({
            type: 'FeatureCollection',
            features: layers[layer]
          })
          vtile.addGeoJSON(geojson, layer)
        }
      } catch (err) {
        return callback(err)
      }

      return zlib.gzip(vtile.getData(), function (err, pbfz) {
        if (err) {
          return callback(err)
        }

        // treat the newest component as the last-modified date
        var lastModified = Math.max.apply(null, headers.map(function (x) {
          return x['last-modified'] || -Infinity
        }))

        // use the minimum max-age value
        var maxAge = Math.min.apply(null, headers.map(function (x) {
          return (((x['cache-control'] || '').match(/max-age=(\d+)/) || [])[1] | 0) || Infinity
        }))

        return callback(null, pbfz, {
          'Cache-Control': 'max-age=' + maxAge,
          'Content-Encoding': 'gzip',
          'Content-Type': 'application/x-protobuf',
          'Last-Modified': new Date(lastModified)
        })
      })
    })
  }

  Merge.prototype.getInfo = function (callback) {
    var info = this.sources
      .map(function (x) {
        return x.info
      }).reduce(function (a, b, i) {
        var info = {}

        a.id = a.id || 'unknown_' + i - 1
        b.id = b.id || 'unknown_' + i

        if (a.attribution === b.attribution) {
          info.attribution = a.attribution
        } else {
          info.attribution = [a.attribution, b.attribution].join(', ')
        }

        if (a.description === b.description) {
          info.description = a.description
        } else {
          info.description = [a.description, b.description].join(', ')
        }

        info.bounds = [
          Math.min(a.bounds[0], b.bounds[0]),
          Math.min(a.bounds[1], b.bounds[1]),
          Math.max(a.bounds[2], b.bounds[2]),
          Math.max(a.bounds[3], b.bounds[3])
        ]

        info.autoscale = a.autoscale && b.autoscale
        info.center = a.center
        info.format = a.format
        info.maskLevel = Math.max(a.maskLevel || a.maxzoom, b.maskLevel || b.maxzoom)
        info.maxzoom = Math.max(a.maxzoom, b.maxzoom)
        info.minzoom = Math.min(a.minzoom, b.minzoom)
        info.name = [a.name, b.name].join(' + ')
        info.private = a.private || b.private
        info.scheme = a.scheme
        info.tilejson = a.tilejson
        info.vector_layers = (a.vector_layers || [{ fields: {}, id: a.id.replace(/\./g, '_') }]).concat(b.vector_layers || [{ fields: {}, id: b.id.replace(/\./g, '_') }])
        info.id = [a.id, b.id].join(',')

        return info
      })

    if (info.maskLevel === info.maxzoom) {
      delete info.maskLevel
    }

    return setImmediate(callback, null, info)
  }

  Merge.prototype.close = function (callback) {
    return callback && setImmediate(callback)
  }

  Merge.registerProtocols = function (tilelive) {
    tilelive.protocols['merge:'] = Merge
  }

  Merge.registerProtocols(tilelive)

  return Merge
}
