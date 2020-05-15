/*
 *  Copyright (c) 2020 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

/*
 * This is a worker doing the encode/decode transformations to add end-to-end
 * encryption to a WebRTC PeerConnection using the Insertable Streams API.
 */

'use strict';
let currentCryptoKey;
let useCryptoOffset = true;
let currentKeyIdentifier = 0;

// If using crypto offset (controlled by a checkbox):
// Do not encrypt the first couple of bytes of the payload. This allows
// a middle to determine video keyframes or the opus mode being used.
// For VP8 this is the content described in
//   https://tools.ietf.org/html/rfc6386#section-9.1
// which is 10 bytes for key frames and 3 bytes for delta frames.
// For opus (where encodedFrame.type is not set) this is the TOC byte from
//   https://tools.ietf.org/html/rfc6716#section-3.1
//
// It makes the (encrypted) video and audio much more fun to watch and listen to
// as the decoder does not immediately throw a fatal error.
const frameTypeToCryptoOffset = {
  key: 10,
  delta: 3,
  undefined: 1,
};

function dump(encodedFrame, direction, max = 16) {
  const data = new Uint8Array(encodedFrame.data);
  let bytes = '';
  for (let j = 0; j < data.length && j < max; j++) {
    bytes += (data[j] < 16 ? '0' : '') + data[j].toString(16) + ' ';
  }
  console.log(performance.now().toFixed(2), direction, bytes.trim(),
      'len=' + encodedFrame.data.byteLength,
      'type=' + (encodedFrame.type || 'audio'),
      'ts=' + encodedFrame.timestamp,
      'ssrc=' + encodedFrame.synchronizationSource
  );
}

let scount = 0;
function encodeFunction(encodedFrame, controller) {
  if (scount++ < 30) { // dump the first 30 packets.
    //dump(encodedFrame, 'send');
  }

//    console.log(currentCryptoKey);  
  if (currentCryptoKey) {

    const cryptoOffset = useCryptoOffset? frameTypeToCryptoOffset[encodedFrame.type] : 0;
    
    const dataToEnc = encodedFrame.data.slice(cryptoOffset);
    const dataHeader = encodedFrame.data.slice(0, cryptoOffset);

    const iv = self.crypto.getRandomValues(new Uint8Array(12));
          
    self.crypto.subtle.encrypt({
                                 name: "AES-GCM",
                                 iv: iv             
    }, currentCryptoKey, dataToEnc).then(function (result) {
        const newData = new Uint8Array(dataHeader.byteLength + result.byteLength + iv.byteLength);
        newData.set(new Uint8Array(dataHeader), 0);
        newData.set(new Uint8Array(result), dataHeader.byteLength);
        newData.set(new Uint8Array(iv), dataHeader.byteLength + result.byteLength);
              
        encodedFrame.data = newData.buffer;
        controller.enqueue(encodedFrame);

    });

      
  } else {
      controller.enqueue(encodedFrame);
  }
}

let rcount = 0;
function decodeFunction(encodedFrame, controller) {
  if (rcount++ < 30) { // dump the first 30 packets
    //dump(encodedFrame, 'recv');
  }
  const view = new DataView(encodedFrame.data);
  const checksum = encodedFrame.data.byteLength > 4 ? view.getUint32(encodedFrame.data.byteLength - 4) : false;

  if (currentCryptoKey) {

    const cryptoOffset = useCryptoOffset? frameTypeToCryptoOffset[encodedFrame.type] : 0;

    const dataHeader = encodedFrame.data.slice(0, cryptoOffset);
    const dataToDec = encodedFrame.data.slice(cryptoOffset, encodedFrame.data.byteLength - 12);
    const iv = encodedFrame.data.slice(encodedFrame.data.byteLength - 12);
    self.crypto.subtle.decrypt({
                                 name: "AES-GCM",
                                 iv: iv             
    }, currentCryptoKey, dataToDec).then(function (result) {
        
        const newData = new Uint8Array(dataHeader.byteLength + result.byteLength);
        newData.set(new Uint8Array(dataHeader), 0);
        newData.set(new Uint8Array(result), dataHeader.byteLength);
              
        encodedFrame.data = newData.buffer;
        controller.enqueue(encodedFrame);

    });

  } else {
    controller.enqueue(encodedFrame);
  } 
}

  function make_video_key() { 
   return new Promise(function(resolve, reject) {
      self.crypto.subtle.generateKey(
	  {
              name: "AES-GCM",
              length: 256, //can be  128, 192, or 256
          },
          true, //whether the key is extractable (i.e. can be used in exportKey)
	  ["encrypt", "decrypt"] //can "encrypt", "decrypt", "wrapKey", or "unwrapKey"
      ).then(function(k) {
          resolve(k)
      }).catch(function(err){
          console.error(err);
      });      
   });
  }


onmessage = async (event) => {
  const {operation} = event.data;
  if (operation === 'encode') {
    const {readableStream, writableStream} = event.data;
    const transformStream = new TransformStream({
      transform: encodeFunction,
    });
    readableStream
        .pipeThrough(transformStream)
        .pipeTo(writableStream);
  } else if (operation === 'decode') {
    const {readableStream, writableStream} = event.data;
    const transformStream = new TransformStream({
      transform: decodeFunction,
    });
    readableStream
        .pipeThrough(transformStream)
        .pipeTo(writableStream);
  } else if (operation === 'setCryptoKey') {
    if (event.data.currentCryptoKey !== currentCryptoKey) {
      currentKeyIdentifier++;
    }
      make_video_key().then(function(k) {currentCryptoKey = k});
    useCryptoOffset = event.data.useCryptoOffset;
  }
};
