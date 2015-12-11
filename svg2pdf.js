/**
 * Renders an svg element to a jsPDF document.
 * For accurate results a DOM document is required (mainly used for text size measurement and image format conversion)
 * @param element {HTMLElement} The svg element, which will be cloned, so the original stays unchanged.
 * @param pdf {jsPDF} The jsPDF object.
 * @param options {object} An object that may contain render options. Currently supported are:
 *                         scale: The global factor by which everything is scaled.
 *                         xOffset, yOffset: Offsets that are added to every coordinate AFTER scaling (They are not
 *                            influenced by the scale attribute).
 */
var svgElementToPdf = (function () {

  var _pdf; // jsPDF pdf-document

  var cToQ = 2 / 3; // ratio to convert quadratic bezier curves to cubic ones

  // pathSegList is marked deprecated in chrome, so parse the d attribute manually if necessary
  var getPathSegList = function (node) {
    var pathSegList = node.pathSegList;
    if (pathSegList) {
      return pathSegList;
    }

    pathSegList = [];

    var d = node.getAttribute("d");

    var regex = /([a-zA-Z])([^a-zA-Z]*)/g,
        match;
    while (match = regex.exec(d)) {
      var coords = parseFloats(match[2]).reverse();
      var pathSeg = {};
      var type = pathSeg.pathSegTypeAsLetter = match[1];
      switch (type) {
        case "h":
        case "H":
          pathSeg.x = coords[0];
          break;

        case "v":
        case "V":
          pathSeg.y = coords[0];
          break;

        case "c":
        case "C":
          pathSeg.x1 = coords[5];
          pathSeg.y1 = coords[4];
        case "s":
        case "S":
          pathSeg.x2 = coords[3];
          pathSeg.y2 = coords[2];
        case "t":
        case "T":
        case "l":
        case "L":
        case "m":
        case "M":
          pathSeg.x = coords[1];
          pathSeg.y = coords[0];
          break;

        case "q":
        case "Q":
          pathSeg.x1 = coords[3];
          pathSeg.y1 = coords[2];
          pathSeg.x = coords[1];
          pathSeg.y = coords[0];
          break;
        // TODO: a,A
      }

      pathSegList.push(pathSeg);
    }

    pathSegList.getItem = function (i) {
      return this[i]
    };
    pathSegList.numberOfItems = pathSegList.length;

    return pathSegList;
  };

  // returns an attribute of a node, either from the node directly or from css
  var getAttribute = function (node, propertyNode, propertyCss) {
    propertyCss = propertyCss || propertyNode;
    return node.getAttribute(propertyNode) || node.style[propertyCss];
  };

  // mirrors p1 at p2
  var mirrorPoint = function (p1, p2) {
    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];

    return [p1[0] + 2 * dx, p1[1] + 2 * dy];
  };

  // transforms a cubic bezier control point to a quadratic one: returns from + (2/3) * (to - from)
  var toCubic = function (from, to) {
    return [cToQ * (to[0] - from[0]) + from[0], cToQ * (to[1] - from[1]) + from[1]];
  };

  // extracts a control point from a previous path segment (for t,T,s,S segments)
  var getControlPointFromPrevious = function (i, from, list, prevX, prevY) {
    var prev = list.getItem(i - 1);
    var p2;
    if (i > 0 && (prev.pathSegTypeAsLetter === "C" || prev.pathSegTypeAsLetter === "S")) {
      p2 = mirrorPoint([prev.x2, prev.y2], from);
    } else if (i > 0 && (prev.pathSegTypeAsLetter === "c" || prev.pathSegTypeAsLetter === "s")) {
      p2 = mirrorPoint([prev.x2 + prevX, prev.y2 + prevY], from);
    } else {
      p2 = [from[0], from[1]];
    }
    return p2;
  };

  // an id prefix to handle duplicate ids
  var SvgPrefix = function (prefix) {
    this.prefix = prefix;
    this.id = 0;
    this.nextChild = function () {
      return new SvgPrefix("_" + this.id++ + "_" + this.get());
    };
    this.get = function () {
      return this.prefix;
    }
  };

  // returns the node for the specified id or incrementally removes prefixes to search "higher" levels
  var getFromDefs = function (id, defs) {
    var regExp = /_\d+_/;
    while (!defs[id] && regExp.exec(id)) {
      id = id.replace(regExp, "");
    }
    return defs[id];
  };

  // replace any newline characters by space and trim
  var removeNewlinesAndTrim = function (str) {
    return str.replace(/[\n\s\r]+/, " ").trim();
  };

  // clones the defs object (or basically any object)
  var cloneDefs = function (defs) {
    var clone = {};
    for (var key in defs) {
      if (defs.hasOwnProperty(key)) {
        clone[key] = defs[key];
      }
    }
    return clone;
  };

  // computes the transform directly applied at the node (such as viewbox scaling and the "transform" atrribute)
  // x,y,cx,cy,r,... are omitted
  var computeNodeTransform = function (node) {
    var height, width, viewBoxHeight, viewBoxWidth, bounds, viewBox, y, x;
    var nodeTransform = _pdf.unitMatrix;
    if (node.is("svg,g")) {
      x = parseFloat(node.attr("x")) || 0;
      y = parseFloat(node.attr("y")) || 0;

      // jquery doesn't like camelCase notation...
      viewBox = node.get(0).getAttribute("viewBox");
      if (viewBox) {
        bounds = parseFloats(viewBox);
        viewBoxWidth = bounds[2] - bounds[0];
        viewBoxHeight = bounds[3] - bounds[1];
        width = parseFloat(node.attr("width")) || viewBoxWidth;
        height = parseFloat(node.attr("height")) || viewBoxHeight;
        nodeTransform = new _pdf.Matrix(width / viewBoxWidth, 0, 0, height / viewBoxHeight, x - bounds[0], y - bounds[1]);
      } else {
        nodeTransform = new _pdf.Matrix(1, 0, 0, 1, x, y);
      }
    } else if (node.is("marker")) {
      x = -parseFloat(node.get(0).getAttribute("refX")) || 0;
      y = -parseFloat(node.get(0).getAttribute("refY")) || 0;

      viewBox = node.get(0).getAttribute("viewBox");
      if (viewBox) {
        bounds = parseFloats(viewBox);
        viewBoxWidth = bounds[2] - bounds[0];
        viewBoxHeight = bounds[3] - bounds[1];
        width = parseFloat(node.get(0).getAttribute("markerWidth")) || viewBoxWidth;
        height = parseFloat(node.get(0).getAttribute("markerHeight")) || viewBoxHeight;

        var s = new _pdf.Matrix(width / viewBoxWidth, 0, 0, height / viewBoxHeight, 0, 0);
        var t = new _pdf.Matrix(1, 0, 0, 1, x - bounds[0], y - bounds[1]);
        nodeTransform = _pdf.matrixMult(t, s);
      } else {
        nodeTransform = new _pdf.Matrix(1, 0, 0, 1, x, y);
      }
    }

    var transformString = node.attr("transform");
    if (!transformString)
      return nodeTransform;
    else
      return _pdf.matrixMult(nodeTransform, parseTransform(transformString));
  };

  // parses the "points" string used by polygons and returns an array of points
  var parsePointsString = function (string) {
    var floats = parseFloats(string);
    var result = [];
    for (var i = 0; i < floats.length - 1; i += 2) {
      var x = floats[i];
      var y = floats[i + 1];
      result.push([x, y]);
    }
    return result;
  };

  // parses the "transform" string
  var parseTransform = function (transformString) {
    if (!transformString)
      return _pdf.unitMatrix;

    var mRegex = /matrix\((.+)\)/,
        tRegex = /translate\((.+)\)/,
        rRegex = /rotate\((.+)\)/,
        sRegex = /scale\((.+)\)/,
        sXRegex = /skewX\((.+)\)/,
        sYRegex = /skewY\((.+)\)/;

    var resultMatrix = _pdf.unitMatrix, m;

    while (transformString.length > 0) {
      var match = mRegex.exec(transformString);
      if (match) {
        m = parseFloats(match[1]);
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(m[0], m[1], m[2], m[3], m[4], m[5]), resultMatrix);
        transformString = transformString.replace(match[0], "");
      }
      match = rRegex.exec(transformString);
      if (match) {
        m = parseFloats(match[1]);
        var a = Math.PI * m[0] / 180;
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0), resultMatrix);
        if (m[1] && m[2]) {
          var t1 = new _pdf.Matrix(1, 0, 0, 1, m[1], m[2]);
          var t2 = new _pdf.Matrix(1, 0, 0, 1, -m[1], -m[2]);
          resultMatrix = _pdf.matrixMult(t2, _pdf.matrixMult(resultMatrix, t1));
        }
        transformString = transformString.replace(match[0], "");
      }
      match = tRegex.exec(transformString);
      if (match) {
        m = parseFloats(match[1]);
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(1, 0, 0, 1, m[0], m[1] || 0), resultMatrix);
        transformString = transformString.replace(match[0], "");
      }
      match = sRegex.exec(transformString);
      if (match) {
        m = parseFloats(match[1]);
        if (!m[1])
          m[1] = m[0];
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(m[0], 0, 0, m[1], 0, 0), resultMatrix);
        transformString = transformString.replace(match[0], "");
      }
      match = sXRegex.exec(transformString);
      if (match) {
        m = parseFloat(match[1]);
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(1, 0, Math.tan(m), 1, 0, 0), resultMatrix);
        transformString = transformString.replace(match[0], "");
      }
      match = sYRegex.exec(transformString);
      if (match) {
        m = parseFloat(match[1]);
        resultMatrix = _pdf.matrixMult(new _pdf.Matrix(1, Math.tan(m), 0, 1, 0, 0), resultMatrix);
        transformString = transformString.replace(match[0], "");
      }
    }
    return resultMatrix;
  };

  // parses a comma and/or whitespace separated string of floats and returns the single floats in an array
  var parseFloats = function (str) {
    return str.replace(/[^eE]-/g, " -").trim().split(/\s*\s|,\s*/).map(parseFloat);
  };

  // multiplies a vector with a matrix: vec' = vec * matrix
  var multVecMatrix = function (vec, matrix) {
    var x = vec[0];
    var y = vec[1];
    return [
      matrix.a * x + matrix.c * y + matrix.e,
      matrix.b * x + matrix.d * y + matrix.f
    ];
  };

  // returns the untransformated bounding box of an svg element (quite expensive for path and polygon objects, as
  // the whole points/d-string has to be processed)
  var getUntransformedBBox = function (node) {
    var i, minX, minY, maxX, maxY, viewBox, vb;

    if (node.is("polygon")) {
      var points = parsePointsString(node.attr("points"));
      minX = Number.POSITIVE_INFINITY;
      minY = Number.POSITIVE_INFINITY;
      maxX = Number.NEGATIVE_INFINITY;
      maxY = Number.NEGATIVE_INFINITY;
      for (i = 0; i < points.length; i++) {
        var point = points[i];
        minX = Math.min(minX, point[0]);
        maxX = Math.max(maxX, point[0]);
        minY = Math.min(minY, point[1]);
        maxY = Math.max(maxY, point[1]);
      }
      return [
        minX,
        minY,
        maxX - minX,
        maxY - minY
      ];
    }

    if (node.is("path")) {
      var list = getPathSegList(node.get(0));
      minX = Number.POSITIVE_INFINITY;
      minY = Number.POSITIVE_INFINITY;
      maxX = Number.NEGATIVE_INFINITY;
      maxY = Number.NEGATIVE_INFINITY;
      var x = 0, y = 0;
      var prevX, prevY;
      var p2, p3, to;
      for (i = 0; i < list.numberOfItems; i++) {
        var seg = list.getItem(i);
        var cmd = seg.pathSegTypeAsLetter;
        switch (cmd) {
          case "H":
            x = seg.x;
            break;
          case "h":
            x = seg.x + x;
            break;
          case "V":
            y = seg.y;
            break;
          case "v":
            y = seg.y + y;
            break;
          case "C":
            p2 = [seg.x1, seg.y1];
            p3 = [seg.x2, seg.y2];
            to = [seg.x, seg.y];
            break;
          case "c":
            p2 = [seg.x1 + x, seg.y1 + y];
            p3 = [seg.x2 + x, seg.y2 + y];
            to = [seg.x + x, seg.y + y];
            break;
          case "S":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p3 = [seg.x2, seg.y2];
            to = [seg.x, seg.y];
            break;
          case "s":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p3 = [seg.x2 + x, seg.y2 + y];
            to = [seg.x + x, seg.y + y];
            break;
          case "Q":
            pf = [seg.x1, seg.y1];
            p2 = toCubic([x, y], pf);
            p3 = toCubic([seg.x, seg.y], pf);
            to = [seg.x, seg.y];
            break;
          case "q":
            pf = [seg.x1 + x, seg.y1 + y];
            p2 = toCubic([x, y], pf);
            p3 = toCubic([x + seg.x, y + seg.y], pf);
            to = [seg.x + x, seg.y + y];
            break;
          case "T":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p2 = toCubic([x, y], pf);
            p3 = toCubic([seg.x, seg.y], pf);
            to = [seg.x, seg.y];
            break;
          case "t":
            pf = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p2 = toCubic([x, y], pf);
            p3 = toCubic([x + seg.x, y + seg.y], pf);
            to = [seg.x + x, seg.y + y];
            break;
          // TODO: A,a
        }
        if ("sScCqQtT".indexOf(cmd) >= 0) {
          prevX = x;
          prevY = y;
        }
        if ("MLCSQT".indexOf(cmd) >= 0) {
          x = seg.x;
          y = seg.y;
        } else if ("mlcsqt".indexOf(cmd) >= 0) {
          x = seg.x + x;
          y = seg.y + y;
        }
        if ("CSQTcsqt".indexOf(cmd) >= 0) {
          minX = Math.min(minX, x, p2[0], p3[0], to[0]);
          maxX = Math.max(maxX, x, p2[0], p3[0], to[0]);
          minY = Math.min(minY, y, p2[1], p3[1], to[1]);
          maxY = Math.max(maxY, y, p2[1], p3[1], to[1]);
        } else {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      return [
        minX,
        minY,
        maxX - minX,
        maxY - minY
      ];
    }

    var pf = parseFloat;
    if (node.is("svg")) {
      viewBox = node.get(0).getAttribute("viewBox");
      if (viewBox) {
        vb = parseFloats(viewBox);
      }
      return [
        pf(node.attr("x")) || (vb && vb[0]) || 0,
        pf(node.attr("y")) || (vb && vb[1]) || 0,
        pf(node.attr("width")) || (vb && vb[2]) || 0,
        pf(node.attr("height")) || (vb && vb[3]) || 0
      ];
    }
    if (node.is("marker")) {
      viewBox = node.get(0).getAttribute("viewBox");
      if (viewBox) {
        vb = parseFloats(viewBox);
      }
      return [
        (vb && vb[0]) || 0,
        (vb && vb[1]) || 0,
        (vb && vb[2]) || pf(node.attr("marker-width")) || 0,
        (vb && vb[3]) || pf(node.attr("marker-height")) || 0
      ];
    }

    // TODO: check if there are other possible coordinate attributes
    var x1 = pf(node.attr("x1")) || pf(node.attr("x")) || pf((node.attr("cx")) - pf(node.attr("r"))) || 0;
    var x2 = pf(node.attr("x2")) || (x1 + pf(node.attr("width"))) || (pf(node.attr("cx")) + pf(node.attr("r"))) || 0;
    var y1 = pf(node.attr("y1")) || pf(node.attr("y")) || (pf(node.attr("cy")) - pf(node.attr("r"))) || 0;
    var y2 = pf(node.attr("y2")) || (y1 + pf(node.attr("height"))) || (pf(node.attr("cy")) + pf(node.attr("r"))) || 0;
    return [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2) - Math.min(x1, x2),
      Math.max(y1, y2) - Math.min(y1, y2)
    ];
  };

  // transforms a bounding box and returns a new rect that contains it
  var transformBBox = function (box, matrix) {
    var bl = multVecMatrix([box[0], box[1]], matrix);
    var br = multVecMatrix([box[0] + box[2], box[1]], matrix);
    var tl = multVecMatrix([box[0], box[1] + box[3]], matrix);
    var tr = multVecMatrix([box[0] + box[2], box[1] + box[3]], matrix);

    var bottom = Math.min(bl[1], br[1], tl[1], tr[1]);
    var left = Math.min(bl[0], br[0], tl[0], tr[0]);
    var top = Math.max(bl[1], br[1], tl[1], tr[1]);
    var right = Math.max(bl[0], br[0], tl[0], tr[0]);

    return [
      left,
      bottom,
      right - left,
      top - bottom
    ]
  };

  // draws a polygon
  var polygon = function (n, tfMatrix, colorMode, gradient, gradientMatrix) {
    var points = parsePointsString(n.attr("points"));
    var lines = [{op: "m", c: multVecMatrix(points[0], tfMatrix)}];
    for (var i = 1; i < points.length; i++) {
      var p = points[i];
      to = multVecMatrix(p, tfMatrix);
      lines.push({op: "l", c: to});
    }
    lines.push({op: "h"});
    _pdf.path(lines, colorMode, gradient, gradientMatrix);
  };

  // draws an image (converts it to jpeg first, as jsPDF doesn't support png or other formats)
  var image = function (n) {
    // convert image to jpeg
    var imageUrl = n.attr("xlink:href") || n.attr("href");
    var image = new Image();
    image.src = imageUrl;

    var canvas = document.createElement("canvas");
    var width = parseFloat(n.attr("width")),
        height = parseFloat(n.attr("height"));
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    var jpegUrl = canvas.toDataURL("image/jpeg");

    _pdf.addImage(jpegUrl,
        "jpeg",
        0,
        0,
        width,
        height
    );
  };

  // draws a path
  var path = function (n, node, tfMatrix, svgIdPrefix, colorMode, gradient, gradientMatrix) {
    var list = getPathSegList(node);

    var getLinesFromPath = function (pathSegList, tfMatrix) {
      var x = 0, y = 0;
      var x0 = x, y0 = y;
      var prevX, prevY;
      var from, to, p2, p3;
      var lines = [];
      var markers = [];
      var op;

      for (var i = 0; i < list.numberOfItems; i++) {
        var seg = list.getItem(i);
        var cmd = seg.pathSegTypeAsLetter;
        switch (cmd) {
          case "M":
            x0 = x;
            y0 = y;
            to = [seg.x, seg.y];
            op = "m";
            break;
          case "m":
            x0 = x;
            y0 = y;
            to = [seg.x + x, seg.y + y];
            op = "m";
            break;
          case "L":
            to = [seg.x, seg.y];
            op = "l";
            break;
          case "l":
            to = [seg.x + x, seg.y + y];
            op = "l";
            break;
          case "H":
            to = [seg.x, y];
            op = "l";
            x = seg.x;
            break;
          case "h":
            to = [seg.x + x, y];
            op = "l";
            x = seg.x + x;
            break;
          case "V":
            to = [x, seg.y];
            op = "l";
            y = seg.y;
            break;
          case "v":
            to = [x, seg.y + y];
            op = "l";
            y = seg.y + y;
            break;
          case "C":
            p2 = [seg.x1, seg.y1];
            p3 = [seg.x2, seg.y2];
            to = [seg.x, seg.y];
            break;
          case "c":
            p2 = [seg.x1 + x, seg.y1 + y];
            p3 = [seg.x2 + x, seg.y2 + y];
            to = [seg.x + x, seg.y + y];
            break;
          case "S":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p3 = [seg.x2, seg.y2];
            to = [seg.x, seg.y];
            break;
          case "s":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p3 = [seg.x2 + x, seg.y2 + y];
            to = [seg.x + x, seg.y + y];
            break;
          case "Q":
            p = [seg.x1, seg.y1];
            p2 = toCubic([x, y], p);
            p3 = toCubic([seg.x, seg.y], p);
            to = [seg.x, seg.y];
            break;
          case "q":
            p = [seg.x1 + x, seg.y1 + y];
            p2 = toCubic([x, y], p);
            p3 = toCubic([x + seg.x, y + seg.y], p);
            to = [seg.x + x, seg.y + y];
            break;
          case "T":
            p2 = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p2 = toCubic([x, y], p);
            p3 = toCubic([seg.x, seg.y], p);
            to = [seg.x, seg.y];
            break;
          case "t":
            p = getControlPointFromPrevious(i, [x, y], list, prevX, prevY);
            p2 = toCubic([x, y], p);
            p3 = toCubic([x + seg.x, y + seg.y], p);
            to = [seg.x + x, seg.y + y];
            break;
          // TODO: A,a
          case "Z":
          case "z":
            x = x0;
            y = y0;
            lines.push({op: "h"});
            break;
        }

        if ("sScCqQtT".indexOf(cmd) >= 0) {
          from = p3;
          prevX = x;
          prevY = y;
          p2 = multVecMatrix(p2, tfMatrix);
          p3 = multVecMatrix(p3, tfMatrix);
          p = multVecMatrix(to, tfMatrix);
          lines.push({
            op: "c", c: [
              p2[0], p2[1],
              p3[0], p3[1],
              p[0], p[1]
            ]
          });
        } else if ("lLhHvVmM".indexOf(cmd) >= 0) {
          from = [x, y];
          p = multVecMatrix(to, tfMatrix);
          lines.push({op: op, c: p});
        }

        if (i === list.numberOfItems - 1
            || ("mM".indexOf(cmd) < 0 && "mM".indexOf(list.getItem(i + 1).pathSegTypeAsLetter) >= 0)) {
          var a = Math.atan2(to[1] - from[1], to[0] - from[0]);
          var tf = new _pdf.Matrix(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), to[0], to[1]);
          markers.push({type: "end", tf: _pdf.matrixMult(tf, tfMatrix)});
        }

        if ("MLCSQT".indexOf(cmd) >= 0) {
          x = seg.x;
          y = seg.y;
        } else if ("mlcsqt".indexOf(cmd) >= 0) {
          x = seg.x + x;
          y = seg.y + y;
        }
      }

      return {lines: lines, markers: markers};
    };
    var lines = getLinesFromPath(list, tfMatrix);

    var markerEnd = n.attr("marker-end");
    if (markerEnd) {
      for (var i = 0; i < lines.markers.length; i++) {
        var marker = lines.markers[i];
        var markerElement;
        switch (marker.type) {
          case "end":
            markerElement = svgIdPrefix.get() + /url\(#(\w+)\)/.exec(markerEnd)[1];
        }
        _pdf.doFormObject(markerElement, marker.tf);
      }
    }

    if (lines.lines.length > 0) {
      _pdf.path(lines.lines, colorMode, gradient, gradientMatrix);
    }
  };

  // draws the element referenced by a use node, makes use of pdf's XObjects/FormObjects so nodes are only written once
  // to the pdf document. This highly reduces the file size and computation time.
  var use = function (n, tfMatrix, svgIdPrefix) {
    var url = (n.attr("href") || n.attr("xlink:href"));
    // just in case someone has the idea to use empty use-tags, wtf???
    if (!url)
      return;

    // get the size of the referenced form object (to apply the correct saling)
    var formObject = _pdf.getFormObject(svgIdPrefix.get() + url.substring(1));

    // scale and position it right
    var x = n.attr("x") || 0;
    var y = n.attr("y") || 0;
    var width = n.attr("width") || formObject.width;
    var height = n.attr("height") || formObject.height;
    var t = _pdf.unitMatrix;
    if (width > 0 && height > 0) {
      t = new _pdf.Matrix(width / formObject.width, 0, 0, height / formObject.height, x, y);
    }
    t = _pdf.matrixMult(t, tfMatrix);
    _pdf.doFormObject(svgIdPrefix.get() + url.substring(1), t);
  };

  // draws a line
  var line = function (n, tfMatrix) {
    var p1 = multVecMatrix([parseFloat(n.attr('x1')), parseFloat(n.attr('y1'))], tfMatrix);
    var p2 = multVecMatrix([parseFloat(n.attr('x2')), parseFloat(n.attr('y2'))], tfMatrix);
    _pdf.line(p1[0], p1[1], p2[0], p2[1]);
  };

  // draws a rect
  var rect = function (n, colorMode, gradient, gradientMatrix) {
    _pdf.roundedRect(
        parseFloat(n.attr('x')) || 0,
        parseFloat(n.attr('y')) || 0,
        parseFloat(n.attr('width')),
        parseFloat(n.attr('height')),
        parseFloat(n.attr('rx')) || 0,
        parseFloat(n.attr('ry')) || 0,
        colorMode,
        gradient,
        gradientMatrix
    );
  };

  // draws an ellipse
  var ellipse = function (n, colorMode, gradient, gradientMatrix) {
    _pdf.ellipse(
        parseFloat(n.attr('cx')) || 0,
        parseFloat(n.attr('cy')) || 0,
        parseFloat(n.attr('rx')),
        parseFloat(n.attr('ry')),
        colorMode,
        gradient,
        gradientMatrix
    );
  };

  // draws a circle
  var circle = function (n, colorMode, gradient, gradientMatrix) {
    var radius = parseFloat(n.attr('r')) || 0;
    _pdf.ellipse(
        parseFloat(n.attr('cx')) || 0,
        parseFloat(n.attr('cy')) || 0,
        radius,
        radius,
        colorMode,
        gradient,
        gradientMatrix
    );
  };

  // draws a text element and its tspan children
  var text = function (n, node, tfMatrix, hasFillColor, fillRGB) {
    var fontFamily = getAttribute(node, "font-family");
    if (fontFamily) {
      switch (fontFamily.toLowerCase()) {
        case 'serif':
          _pdf.setFont('times');
          break;
        case 'monospace':
          _pdf.setFont('courier');
          break;
        default:
          _pdf.setFont('helvetica');
          break;
      }
    }

    if (hasFillColor) {
      _pdf.setTextColor(fillRGB.r, fillRGB.g, fillRGB.b);
    }

    var fontType;
    var fontWeight = getAttribute(node, "font-weight");
    if (fontWeight) {
      if (fontWeight === "bold") {
        fontType = "bold";
      }
    }

    var fontStyle = getAttribute(node, "font-style");
    if (fontStyle) {
      if (fontStyle === "italic") {
        fontType += "italic";
      }
    }
    _pdf.setFontType(fontType);

    var pdfFontSize = 16;
    var fontSize = getAttribute(node, "font-size");
    if (fontSize) {
      pdfFontSize = parseFloat(fontSize);
    }

    var getTextOffset = function (textAnchor, width) {
      var xOffset = 0;
      switch (textAnchor) {
        case 'end':
          xOffset = width;
          break;
        case 'middle':
          xOffset = width / 2;
          break;
        case 'start':
          break;
      }
      return xOffset;
    };

    // creates an svg element and append the text node to properly measure the text size
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.appendChild(node);
    svg.setAttribute("visibility", "hidden");
    document.body.appendChild(svg);

    var box = node.getBBox();
    var x, y, xOffset = 0;
    var textAnchor = getAttribute(node, "text-anchor");
    if (textAnchor) {
      xOffset = getTextOffset(textAnchor, box.width);
    }
    // Only supported measuring unit is "em"!
    var m = new _pdf.Matrix(
        tfMatrix.a, tfMatrix.b, tfMatrix.c, tfMatrix.d,
        tfMatrix.e + (parseFloat(n.attr('x')) || 0),
        tfMatrix.f + (parseFloat(n.attr('y')) || 0)
    );
    x = (parseFloat(n.attr("dx")) || 0) * pdfFontSize;
    y = (parseFloat(n.attr("dy")) || 0) * pdfFontSize;
    _pdf.setFontSize(pdfFontSize);

    // when there are no tspans draw the text directly
    if (node.childElementCount === 0) {
      _pdf.text(
          (x - xOffset),
          y,
          removeNewlinesAndTrim(n.text()),
          void 0,
          m
      );
    } else {
      // otherwise loop over tspans and position each relative to the previous one
      n.children().each(function (i, tSpan) {
        var xOffset = getTextOffset(textAnchor, tSpan.getComputedTextLength());
        var s = $(tSpan);
        x += (parseFloat(s.attr("dx")) || 0) * pdfFontSize;
        y += (parseFloat(s.attr("dy")) || 0) * pdfFontSize;
        _pdf.text(
            x - xOffset,
            y,
            removeNewlinesAndTrim(s.text()),
            void 0,
            m
        );
      });
    }

    document.body.removeChild(svg);
  };

  // As defs elements are allowed to appear after they are referenced, we search for them at first
  var findAndRenderDefs = function (n, tfMatrix, defs, svgIdPrefix, withinDefs) {
    n.children().each(function (i, child) {
      if (child.tagName.toLowerCase() === "defs") {
        renderNode(child, tfMatrix, defs, svgIdPrefix, withinDefs);
        // prevent defs from being evaluated twice // TODO: make this better
        child.parentNode.removeChild(child);
      }
    });
  };

  // processes a svg node
  var svg = function (n, tfMatrix, defs, svgIdPrefix, withinDefs) {
    // create a new prefix and clone the defs, as defs within the svg should not be visible outside
    var newSvgIdPrefix = svgIdPrefix.nextChild();
    var newDefs = cloneDefs(defs);
    findAndRenderDefs(n, tfMatrix, newDefs, newSvgIdPrefix, withinDefs);
    renderChildren(n, tfMatrix, newDefs, newSvgIdPrefix, withinDefs);
  };

  // renders all children of a node
  var renderChildren = function (n, tfMatrix, defs, svgIdPrefix, withinDefs) {
    n.children().each(function (i, node) {
      renderNode(node, tfMatrix, defs, svgIdPrefix, withinDefs);
    });
  };

  // adds a gradient to defs and the pdf document for later use, type is either "axial" or "radial"
  // opacity is only supported rudimentary by avaraging over all stops
  // transforms are applied on use
  var putGradient = function (n, node, type, coords, defs, svgIdPrefix) {
    var colors = [];
    var opacitySum = 0;
    var hasOpacity = false;
    var gState;
    n.children().each(function (i, element) {
      // since opacity gradients are hard to realize, avarage the opacity over the control points
      if (element.tagName.toLowerCase() === "stop") {
        var e = $(element);
        var color = new RGBColor(getAttribute(element, "stop-color"));
        colors.push({
          offset: parseFloat(e.attr("offset")),
          color: [color.r, color.g, color.b]
        });
        var opacity = getAttribute(element, "stop-opacity");
        if (opacity && opacity != 1) {
          opacitySum += parseFloat(opacity);
          hasOpacity = true;
        }
      }
    });

    if (hasOpacity) {
      gState = new _pdf.GState({opacity: opacitySum / coords.length});
    }

    var pattern = new _pdf.Pattern(type, coords, colors, gState);
    var id = svgIdPrefix.get() + n.attr("id");
    _pdf.addPattern(id, pattern);
    defs[id] = node;
  };


  /**
   * Renders a svg node.
   * @param node The svg element
   * @param contextTransform The current transformation matrix
   * @param defs The defs map holding all svg nodes that can be referenced
   * @param svgIdPrefix The current id prefix
   * @param withinDefs True iff we are top-level within a defs node, so the target can be switched to an pdf form object
   */
  var renderNode = function (node, contextTransform, defs, svgIdPrefix, withinDefs) {

    var n = $(node); // jquery node for comfort


    var tfMatrix,
        hasFillColor = false,
        fillRGB = null,
        colorMode = null,
        gradient = null,
        gradientMatrix = null,
        bBox;

    //
    // Decide about the render target and set the correct transformation
    //

    // if we are within a defs node, start a new pdf form object and draw this node and all children on that instead
    // of the top-level page
    var targetIsFormObject = withinDefs && "lineargradient,radialgradient".indexOf(node.tagName.toLowerCase()) < 0;
    if (targetIsFormObject) {

      // the transformations directly at the node are written to the pdf form object transformation matrix
      tfMatrix = computeNodeTransform(n);
      bBox = getUntransformedBBox(n);

      _pdf.beginFormObject(bBox[0], bBox[1], bBox[2], bBox[3], tfMatrix);

      // continue without transformation and set withinDefs to false to prevent child nodes from starting new form objects
      tfMatrix = _pdf.unitMatrix;
      withinDefs = false;

    } else {
      tfMatrix = _pdf.matrixMult(computeNodeTransform(n), contextTransform);
      _pdf.saveGraphicsState();
    }

    //
    // extract fill and stroke mode
    //

    // fill mode
    if (n.is('g,path,rect,text,ellipse,line,circle,polygon')) {
      var fillColor = n.attr('fill');
      if (fillColor) {
        var url = /url\(#(\w+)\)/.exec(fillColor);
        if (url) {
          // probably a gradient (or something unsupported)
          gradient = svgIdPrefix.get() + url[1];
          var fill = getFromDefs(gradient, defs);
          if ("lineargradient,radialgradient".indexOf(fill.tagName.toLowerCase()) >= 0) {

            // matrix to convert between gradient space and user space
            // for "userSpaceOnUse" this is the current transformation: tfMatrix
            // for "objectBoundingBox" or default, the gradient gets scaled and transformed to the bounding box
            var gradientUnitsMatrix = tfMatrix;
            if (!fill.hasAttribute("gradientUnits")
                || fill.getAttribute("gradientUnits").toLowerCase() === "objectboundingbox") {
              bBox = getUntransformedBBox(n);
              gradientUnitsMatrix = new _pdf.Matrix(bBox[2], 0, 0, bBox[3], bBox[0], bBox[1]);

              var nodeTransform = computeNodeTransform(n);
              gradientUnitsMatrix = _pdf.matrixMult(gradientUnitsMatrix, nodeTransform);
            }

            // matrix that is applied to the gradient before any other transformations
            var gradientTransform = parseTransform(fill.getAttribute("gradientTransform"));

            gradientMatrix = _pdf.matrixMult(gradientTransform, gradientUnitsMatrix);
          }
        } else {
          // plain color
          fillRGB = new RGBColor(fillColor);
          if (fillRGB.ok) {
            hasFillColor = true;
            colorMode = 'F';
          } else {
            colorMode = null;
          }
        }
      } else {
        // if no fill attribute is provided the default fill color is black
        fillRGB = new RGBColor("rgb(0, 0, 0)");
        hasFillColor = true;
        colorMode = "F";
      }

      // opacity is realized via a pdf graphics state
      var opacity = n.attr("opacity") || n.attr("fill-opacity");
      if (opacity) {
        _pdf.setGState(new _pdf.GState({opacity: parseFloat(opacity)}));
      } else {
        _pdf.setGState(new _pdf.GState({opacity: 1.0}));
      }
    }

    if (n.is('g,path,rect,ellipse,line,circle,polygon')) {
      // text has no fill color, so apply it not until here
      if (hasFillColor) {
        _pdf.setFillColor(fillRGB.r, fillRGB.g, fillRGB.b);
      }

      // stroke mode
      var strokeColor = n.attr('stroke');
      if (strokeColor) {
        if (node.hasAttribute("stroke-width")) {
          _pdf.setLineWidth(Math.abs(parseFloat(n.attr('stroke-width'))));
        }
        var strokeRGB = new RGBColor(strokeColor);
        if (strokeRGB.ok) {
          _pdf.setDrawColor(strokeRGB.r, strokeRGB.g, strokeRGB.b);
          colorMode = (colorMode || "") + "D";
        }
        if (node.hasAttribute("stroke-linecap")) {
          _pdf.setLineCap(n.attr("stroke-linecap"));
        }
        if (node.hasAttribute("stroke-linejoin")) {
          _pdf.setLineJoin(n.attr("stroke-linejoin"));
        }
        if (node.hasAttribute("stroke-dasharray")) {
          _pdf.setLineDashPattern(
              parseFloats(n.attr("stroke-dasharray")),
              parseInt(n.attr("stroke-dashoffset")) || 0
          );
        }
      }
    }

    // do the actual drawing
    switch (node.tagName.toLowerCase()) {
      case 'svg':
        svg(n, tfMatrix, defs, svgIdPrefix, withinDefs);
        break;
      case 'g':
        findAndRenderDefs(n, tfMatrix, defs, svgIdPrefix, withinDefs);
      case 'a':
      case "marker":
        renderChildren(n, tfMatrix, defs, svgIdPrefix, withinDefs);
        break;

      case 'defs':
        renderChildren(n, tfMatrix, defs, svgIdPrefix, true);
        break;

      case 'use':
        use(n, tfMatrix, svgIdPrefix);
        break;

      case 'line':
        line(n, tfMatrix);
        break;

      case 'rect':
        _pdf.setCurrentTransformationMatrix(tfMatrix);
        rect(n, colorMode, gradient, gradientMatrix);
        break;

      case 'ellipse':
        _pdf.setCurrentTransformationMatrix(tfMatrix);
        ellipse(n, colorMode, gradient, gradientMatrix);
        break;

      case 'circle':
        _pdf.setCurrentTransformationMatrix(tfMatrix);
        circle(n, colorMode, gradient, gradientMatrix);
        break;
      case 'text':
        text(n, node, tfMatrix, hasFillColor, fillRGB);
        break;

      case 'path':
        path(n, node, tfMatrix, svgIdPrefix, colorMode, gradient, gradientMatrix);
        break;

      case 'polygon':
        polygon(n, tfMatrix, colorMode, gradient, gradientMatrix);
        break;

      case 'image':
        _pdf.setCurrentTransformationMatrix(tfMatrix);
        image(n);
        break;

      case "lineargradient":
        putGradient(n, node, "axial", [n.attr("x1"), n.attr("y1"), n.attr("x2"), n.attr("y2")], defs, svgIdPrefix);
        break;

      case "radialgradient":
        var coords = [
          n.attr("fx") || n.attr("cx"),
          n.attr("fy") || n.attr("cy"),
          0,
          n.attr("cx") || 0,
          n.attr("cy") || 0,
          n.attr("r") || 0
        ];
        putGradient(n, node, "radial", coords, defs, svgIdPrefix);
        break;
    }

    // close either the formObject or the graphics context
    if (targetIsFormObject) {
      _pdf.endFormObject(svgIdPrefix.get() + n.attr("id"));
    } else {
      _pdf.restoreGraphicsState();
    }
  };

  // the actual svgToPdf function (see above)
  return function (element, pdf, options) {
    _pdf = pdf;

    var k = options.scale || 1.0,
        xOffset = options.xOffset || 0.0,
        yOffset = options.yOffset || 0.0;

    // set offsets and scale everything by k
    _pdf.saveGraphicsState();
    _pdf.setCurrentTransformationMatrix(new _pdf.Matrix(k, 0, 0, k, xOffset, yOffset));

    renderNode(element.cloneNode(true), _pdf.unitMatrix, {}, new SvgPrefix(""), false);

    _pdf.restoreGraphicsState();

    return _pdf;
  };
})();