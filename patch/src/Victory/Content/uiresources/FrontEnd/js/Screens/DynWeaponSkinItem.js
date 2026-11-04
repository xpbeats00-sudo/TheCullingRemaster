function DynWeaponSkinItemScreen(args)
{
  DynAppearanceItemScreen.call(this, args);
}

DynWeaponSkinItemScreen.prototype = Object.create(DynAppearanceItemScreen.prototype);
DynWeaponSkinItemScreen.prototype.constructor = DynWeaponSkinItemScreen;

DynWeaponSkinItemScreen.prototype.RefreshItems = function(forceIdx)
{
  engine.call("GetWeaponCustomizations", this.category).then($.proxy(function(items){
    this.OnGetItems(items);
    if(parseInt(forceIdx, 10) > this.screenData.Items.length)
    {
      for (var i = 0; i < this.screenData.Items.length; ++i)
      {
        if (parseInt(this.screenData.Items[i].ItemID, 10) == parseInt(forceIdx, 10))
        {
          forceIdx = i;
          ClickedItemIndex = i;
        }
      }
    }
    if(forceIdx != undefined)
    {
      this.ForceFocusIndex(forceIdx);
      this.SetPreviewItem(this.screenData.Items[forceIdx]);
    }
    else
    {
      if(ClickedItemIndex != 0)
      {
        // console.log(JSON.strigify(items));
        console.log("RefreshItems SetPreviewItem 2" + ClickedItemIndex);
        this.SetPreviewItem(this.screenData.Items[ClickedItemIndex]);
      }
      else
      {
        console.log("RefreshItems SetPreviewItem 3");
        this.SetPreviewItem(this.screenData.Items[0]);
      }
    }
    this.rivetsBinder.update({screenData : this.screenData});
  }, this));
}

DynWeaponSkinItemScreen.prototype.GetScreenName = function()
{
    return rivets.formatters.getLocalizedNameForItem(this.category).toUpperCase();
}

DynWeaponSkinItemScreen.prototype.UnequipItem = function()
{
  engine.call("ClearWeaponCustomization", this.category).then($.proxy(function(){
    console.log("Refreshing Items");
    this.RefreshItems();
  }, this));
}

Screens['DynWeaponSkinItem'] = DynWeaponSkinItemScreen;

// "EQUIP TO ALL": put the previewed skin on every weapon that has a skin with
// the same name (e.g. Shadow exists for every weapon, USA only for a few).
// The button sits in the outer (flex column) purchase/equip panel, right under
// the EQUIP box: the EQUIP box's own container is a fixed-height row that
// clipped it. Shown only on weapon-skin screens, for unlocked skins.
$('head').append('<style>' +
  '#cust-equip-all-button { width: 12vw; height: 5vh; padding: 0 1vw; margin-top: 1.2vw; display: none;' +
  ' flex-direction: row; align-items: center; justify-content: center; color: white;' +
  ' font-family: Sucrose-Bold; font-size: 1.3vw; background: rgba(10, 10, 10, 0.55);' +
  ' border: 2px solid rgba(170, 170, 170, 0.9); border-radius: 2.5vh; }' +
  '#cust-equip-all-button:hover { background: rgba(120, 0, 0, 0.35);' +
  ' border-color: rgba(204, 0, 0, 1); box-shadow: 0 0 18px rgba(204, 0, 0, 0.9); }' +
  '</style>');

function UpdateEquipAllButton(screen) {
  var button = document.getElementById("cust-equip-all-button");
  if (!button) {
    var panel = document.getElementById("cust-purchase-equip-container");
    if (!panel) {
      return;
    }
    $(panel).append(
      '<div id="cust-equip-all-button" onmousedown="DynWeaponSkinItemScreen.EquipPreviewedSkinOnAllWeapons()">' +
      '<span>EQUIP TO ALL</span></div>');
    button = document.getElementById("cust-equip-all-button");
  }
  var item = screen && screen.screenData && screen.screenData.PreviewItem;
  var show = screen instanceof DynWeaponSkinItemScreen && item && item.bIsUnlocked;
  button.style.display = show ? "flex" : "none";
}

var stockAppearanceItemOnShow = DynAppearanceItemScreen.prototype.OnShow;
DynAppearanceItemScreen.prototype.OnShow = function () {
  stockAppearanceItemOnShow.apply(this, arguments);
  UpdateEquipAllButton(GetActiveScreen());
};

var stockAppearanceSetPreviewItem = DynAppearanceItemScreen.prototype.SetPreviewItem;
DynAppearanceItemScreen.prototype.SetPreviewItem = function () {
  var result = stockAppearanceSetPreviewItem.apply(this, arguments);
  UpdateEquipAllButton(GetActiveScreen());
  return result;
};

DynWeaponSkinItemScreen.EquipPreviewedSkinOnAllWeapons = function () {
  var screen = GetActiveScreen();
  var skin = screen.screenData.PreviewItem;
  if (!skin || !skin.bIsUnlocked || !skin.DisplayName) {
    return;
  }
  var skinName = String(skin.DisplayName).toLowerCase();
  var weapons = WeaponsListScreenData.AllWeapons;
  var pending = weapons.length;
  var equipped = 0;
  console.log("EquipPreviewedSkinOnAllWeapons: " + skinName + " on " + pending + " weapons");

  var finish = function () {
    if (--pending > 0) {
      return;
    }
    console.log("EquipPreviewedSkinOnAllWeapons: equipped on " + equipped + " weapons");
    screen.RefreshItems(skin.ItemID);
  };

  Array.prototype.forEach.call(weapons, function (weapon) {
    engine.call("GetWeaponCustomizations", weapon.name).then(function (items) {
      var match = null;
      for (var i = 0; items && i < items.length; i++) {
        if (items[i].bIsUnlocked && String(items[i].DisplayName).toLowerCase() == skinName) {
          match = items[i];
          break;
        }
      }
      if (match) {
        equipped++;
        engine.call("SetCustomization", match.AssetName, "weapitem").then(finish);
      } else {
        finish();
      }
    });
  });
};
