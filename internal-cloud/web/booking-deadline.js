/**
 * KST 예약 마감 (방문일 전날 16:00 신청·수정 / 14:00 취소)
 * — booking.html, my-reservations.html, index.html 에서 사용
 */
(function (global) {
  'use strict';

  function kstYmd(d) {
    d = d || new Date();
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    var y = '';
    var m = '';
    var day = '';
    parts.forEach(function (p) {
      if (p.type === 'year') y = p.value;
      if (p.type === 'month') m = p.value;
      if (p.type === 'day') day = p.value;
    });
    return y + '-' + m + '-' + day;
  }

  function currentKstMinutes(d) {
    d = d || new Date();
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    var h = 0;
    var mi = 0;
    parts.forEach(function (p) {
      if (p.type === 'hour') h = parseInt(p.value, 10);
      if (p.type === 'minute') mi = parseInt(p.value, 10);
    });
    return h * 60 + mi;
  }

  function addDaysYmd(ymd, delta) {
    var segs = ymd.slice(0, 10).split('-');
    var y = parseInt(segs[0], 10);
    var m = parseInt(segs[1], 10);
    var d = parseInt(segs[2], 10);
    var kstMidnightUtc = Date.UTC(y, m - 1, d - 1, 15, 0, 0);
    var target = kstMidnightUtc + delta * 24 * 60 * 60 * 1000;
    return kstYmd(new Date(target));
  }

  function isUserActionAllowed(reservationDateYmd, kind, now) {
    now = now || new Date();
    var visit = String(reservationDateYmd || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(visit)) return false;

    var today = kstYmd(now);
    var deadlineDay = addDaysYmd(visit, -1);

    if (kind === 'cancel') {
      if (today >= visit) return false;
      if (today < deadlineDay) return true;
      if (today > deadlineDay) return false;
      return currentKstMinutes(now) <= 14 * 60;
    }

    if (today < deadlineDay) return true;
    if (today > deadlineDay) return false;
    return currentKstMinutes(now) <= 16 * 60;
  }

  function deadlineErrorMessage(kind) {
    if (kind === 'cancel') {
      return '예약 취소는 방문일 전날 14:00까지 가능합니다. (당일 취소 불가)';
    }
    return '예약 신청·수정은 방문일 전날 16:00까지 가능합니다.';
  }

  function isApprovedStatus(status) {
    var s = String(status || '').trim();
    return s === '승인' || s === '대기';
  }

  global.MVRS_BOOKING_DEADLINE = {
    kstYmd: kstYmd,
    isUserActionAllowed: isUserActionAllowed,
    deadlineErrorMessage: deadlineErrorMessage,
    isApprovedStatus: isApprovedStatus,
    addDaysYmd: addDaysYmd,
  };
})(typeof window !== 'undefined' ? window : globalThis);
